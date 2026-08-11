// =====================================================================
// Scheduled password rotation for clinical staff.
//
// The clinic picks how long a password may live — one week, two weeks, or one
// month — and the clock runs PER USER from the moment they last set their own
// password. Change it on a Saturday and it is good for a full period from that
// Saturday. Nobody gets a short cycle because of when in the week they happened
// to log in, and expiries spread themselves across the calendar instead of
// landing on the whole clinic at once.
//
// Scope: doctor, staff and lab only. Patients are not clinic employees, and
// admins are exempt on purpose — the admin holds the on/off switch, and an
// admin locked out by the feature they control has no way back in without a
// DB edit. Note this is the ROLE 'admin', not the ADMIN_ACCESS permission: a
// doctor granted admin access is still clinical staff and still rotates, and
// the real admin account remains the way back in either way.
//
// Two rules sit on top of the plain "older than the interval" test:
//
//   1. A password the user never chose — an admin-created account still on its
//      emailed temp password, or one reset by scripts/set-password.js — is due
//      immediately. The admin knows that password, so it is not a credential
//      the user owns. The grace floor below deliberately does NOT cover this.
//
//   2. A password the user DID choose is never expired while it is younger than
//      MINIMUM_PASSWORD_AGE_DAYS. Today every interval is longer than the floor,
//      so it does not bite; it is the backstop that stops a shortened interval
//      expiring somebody the same morning they set a new password.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('./clinicTime');

const { Setting } = db;

const ENABLED_KEY  = 'passwordRotationEnabled';
const INTERVAL_KEY = 'passwordRotationInterval';

// Roles subject to rotation. Anything not in here is never asked to rotate.
const ROTATING_ROLES = ['doctor', 'staff', 'lab'];

// A self-chosen password younger than this is never expired, whatever the
// interval says. See rule 2 above.
const MINIMUM_PASSWORD_AGE_DAYS = 3;
const DAY_MS = 86_400_000;

// The intervals an admin can choose from. `label` is what staff are shown, so
// it has to read as a sentence fragment in "set a new password <label>".
// `months`/`days` is how the period is added to or subtracted from an instant.
// `label`      reads as a sentence fragment in "set a new password <label>"
// `description` is the option's own name on the admin picker
// `duration`    spells the period out, so the picker does not make the admin
//               work out what "every two weeks" means in days
const INTERVALS = {
  weekly: {
    value: 'weekly', label: 'every week', description: 'Every week',
    duration: '7 days', days: 7,
  },
  fortnightly: {
    value: 'fortnightly', label: 'every two weeks', description: 'Every two weeks',
    duration: '14 days', days: 14,
  },
  monthly: {
    value: 'monthly', label: 'every month', description: 'Every month',
    duration: '1 calendar month', months: 1,
  },
};
const DEFAULT_INTERVAL = 'weekly';

const isValidInterval = (v) => Object.prototype.hasOwnProperty.call(INTERVALS, v);

// ---------------------------------------------------------------------
// Config (feature flag + interval)
// ---------------------------------------------------------------------
// authenticate() runs on every protected request, so reading the Setting rows
// each time would add a query per request. Cached in process with a short TTL,
// and busted outright when an admin changes something — so a change is instant
// on this process and at most TTL-stale on any other.
const CACHE_TTL_MS = 60_000;
let cached = { config: null, at: 0 };

const getRotationConfig = async () => {
  if (cached.config && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config;
  try {
    const rows = await Setting.findAll({ where: { key: [ENABLED_KEY, INTERVAL_KEY] } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const interval = byKey.get(INTERVAL_KEY);
    config = {
      enabled: byKey.get(ENABLED_KEY) === 'true',
      interval: isValidInterval(interval) ? interval : DEFAULT_INTERVAL,
    };
  } catch {
    // Settings unreadable (e.g. DB blip) — fail OPEN. Locking every clinical
    // user out of the system because a settings lookup failed is a far worse
    // outcome than a password living a few minutes past its expiry.
    return { enabled: false, interval: DEFAULT_INTERVAL };
  }

  cached = { config, at: Date.now() };
  return config;
};

// Drops the cached config. For tests and for any path that writes the Setting
// rows without going through setRotationConfig.
const clearRotationCache = () => { cached = { config: null, at: 0 }; };

// Writes whichever of the two the caller passes, leaving the other alone.
const setRotationConfig = async ({ enabled, interval } = {}) => {
  if (interval !== undefined && !isValidInterval(interval)) {
    throw new Error(`Unknown rotation interval '${interval}'`);
  }

  const write = async (key, value) => {
    const [row, created] = await Setting.findOrCreate({
      where: { key },
      defaults: { key, value },
    });
    if (!created && row.value !== value) await row.update({ value });
  };

  if (enabled !== undefined)  await write(ENABLED_KEY, enabled ? 'true' : 'false');
  if (interval !== undefined) await write(INTERVAL_KEY, interval);

  clearRotationCache();
  return getRotationConfig();
};

// ---------------------------------------------------------------------
// Interval arithmetic
// ---------------------------------------------------------------------
// Month arithmetic clamps rather than overflowing: one month after 31 January
// is 28 February, not 3 March. Plain setMonth() rolls the surplus days into the
// following month, which would hand a January user three extra days and make
// "one month" mean different things depending on the date.
const addMonths = (date, n) => {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
  return d;
};

// Shifts an instant by one whole interval. sign = 1 forwards, -1 backwards.
const shiftByInterval = (date, interval = DEFAULT_INTERVAL, sign = 1) => {
  const spec = INTERVALS[interval] || INTERVALS[DEFAULT_INTERVAL];
  if (spec.months) return addMonths(date, sign * spec.months);
  const d = new Date(date);
  d.setDate(d.getDate() + sign * spec.days);
  return d;
};

// The instant a password must have been set AFTER to still be valid. Anything
// set at or before this is older than one whole interval. Expressed as a real
// Date so the same predicate can be handed to Sequelize as a WHERE clause.
const expiryCutoff = (interval = DEFAULT_INTERVAL, now = new Date()) =>
  shiftByInterval(now, interval, -1);

// When THIS user's current password lapses. Null when they have never set one
// themselves — there is no clock to run, they are simply due.
const passwordExpiresAt = (user, interval = DEFAULT_INTERVAL) =>
  user.passwordChangedAt ? shiftByInterval(new Date(user.passwordChangedAt), interval, 1) : null;

// ---------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------
// Pure and flag-agnostic: "is this password older than one interval?" Callers
// decide whether the feature is on. Exported for tests.
const isPasswordExpired = (user, interval = DEFAULT_INTERVAL, now = new Date()) => {
  if (!ROTATING_ROLES.includes(user.role)) return false;

  // Never set by the user themselves — an admin-issued temp password. Due by
  // definition: it is a password the user did not choose and the admin knows.
  // The grace floor below is deliberately not applied here.
  if (!user.passwordChangedAt) return true;

  const changedAt = new Date(user.passwordChangedAt);

  // Grace floor: too new to expire, whatever the interval is.
  if (now - changedAt < MINIMUM_PASSWORD_AGE_DAYS * DAY_MS) return false;

  return changedAt <= expiryCutoff(interval, now);
};

// The same rule as isPasswordExpired, as a Sequelize where-fragment.
//
// Sequelize cannot run a JS predicate inside SQL, so "is this password expired"
// genuinely has to be expressed twice. Keeping both in this file, adjacent, is
// the next best thing to not duplicating it: a change to one that is not
// mirrored in the other is visible in the same screenful rather than hidden in
// a controller. Both are driven by the same expiryCutoff(), which is the part
// that actually encodes the interval.
//
// The grace floor is deliberately not repeated here: every interval is longer
// than the floor, so anything the floor would protect already sits on the safe
// side of the cutoff.
const expiredWhere = (interval = DEFAULT_INTERVAL, now = new Date()) => ({
  [Op.or]: [
    { passwordChangedAt: null },
    { passwordChangedAt: { [Op.lte]: expiryCutoff(interval, now) } },
  ],
});

// Still valid, but lapses within `days`. Complements expiredWhere: the two
// ranges touch at the cutoff and never overlap.
const dueSoonWhere = (interval = DEFAULT_INTERVAL, days = 7, now = new Date()) => ({
  passwordChangedAt: {
    [Op.gt]: expiryCutoff(interval, now),
    [Op.lte]: expiryCutoff(interval, new Date(now.getTime() + days * DAY_MS)),
  },
});

// The whole answer for one user: is a change required right now, when does the
// current password lapse, and how is the policy described? Used by login,
// /auth/me and the request gate.
const getRotationStatus = async (user, now = new Date()) => {
  const { enabled, interval } = await getRotationConfig();

  if (!enabled || !ROTATING_ROLES.includes(user.role)) {
    return {
      enabled, interval, applies: false,
      mustChangePassword: false, expiresOn: null, policyLabel: null,
    };
  }

  const expiresAt = passwordExpiresAt(user, interval);

  return {
    enabled,
    interval,
    applies: true,
    mustChangePassword: isPasswordExpired(user, interval, now),
    // Rendered as the clinic's calendar date, so the frontend keeps receiving
    // the plain 'YYYY-MM-DD' it already knows how to display without shifting
    // it a day in the browser's timezone.
    expiresOn: expiresAt ? clinicToday(expiresAt) : null,
    policyLabel: INTERVALS[interval].label,
  };
};

module.exports = {
  ENABLED_KEY,
  INTERVAL_KEY,
  ROTATING_ROLES,
  MINIMUM_PASSWORD_AGE_DAYS,
  INTERVALS,
  DEFAULT_INTERVAL,
  isValidInterval,
  getRotationConfig,
  setRotationConfig,
  clearRotationCache,
  shiftByInterval,
  expiryCutoff,
  expiredWhere,
  dueSoonWhere,
  passwordExpiresAt,
  isPasswordExpired,
  getRotationStatus,
};
