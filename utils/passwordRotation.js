// =====================================================================
// Scheduled password rotation for clinical staff.
//
// The clinic picks how often staff must set a new password — every week,
// every two weeks, or every month — and the rotation always lands on a
// MONDAY. That is the whole design: a password is expired when it is older
// than the START of the current period, not when it is N days old. Everyone
// rotates together on the same Monday morning, so "change your password" is a
// shared routine rather than 40 staggered personal anniversaries nobody can
// predict.
//
// The consequence worth knowing: a password set the Saturday before a rotation
// Monday still expires two days later. That is inherent to a fixed rotation
// day and is the behaviour that was asked for.
//
// Scope: doctor, staff and lab only. Patients are not clinic employees, and
// admins are exempt on purpose — the admin holds the on/off switch, and an
// admin locked out by the feature they control has no way back in without a
// DB edit. Note this is the ROLE 'admin', not the ADMIN_ACCESS permission: a
// doctor granted admin access is still clinical staff and still rotates, and
// the real admin account remains the way back in either way.
// =====================================================================

const db = require('../models');
const { clinicToday, clinicMidnight } = require('./clinicTime');

const { Setting } = db;

const ENABLED_KEY  = 'passwordRotationEnabled';
const INTERVAL_KEY = 'passwordRotationInterval';

// Roles subject to rotation. Anything not in here is never asked to rotate.
const ROTATING_ROLES = ['doctor', 'staff', 'lab'];

// The day the period turns over, as JS getUTCDay() numbers it (0 = Sunday).
const ROTATION_DAY = 1; // Monday
const ROTATION_DAY_NAME = 'Monday';

// The intervals an admin can choose from. `label` is what staff are shown, so
// it has to read as a sentence fragment in "set a new password <label>".
const INTERVALS = {
  weekly:      { value: 'weekly',      label: 'every Monday',                  description: 'Every week' },
  fortnightly: { value: 'fortnightly', label: 'every second Monday',           description: 'Every two weeks' },
  monthly:     { value: 'monthly',     label: 'the first Monday of the month', description: 'Every month' },
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
// Date helpers, in clinic time
// ---------------------------------------------------------------------
// Dates here stay in the 'YYYY-MM-DD' string space that clinicTime works in.
// Weekday is read off a UTC anchor built from the clinic's own Y/M/D, so it is
// the weekday of the clinic's date and not of whatever instant the server is
// living in.
const weekdayOf = (clinicDate) => {
  const [y, m, d] = String(clinicDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const shiftDate = (clinicDate, days) => {
  const [y, m, d] = String(clinicDate).split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12)); // noon anchor, DST-safe
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
};

// The Monday on or before a given date.
const mondayOnOrBefore = (clinicDate) =>
  shiftDate(clinicDate, -((weekdayOf(clinicDate) - ROTATION_DAY + 7) % 7));

// The first Monday of the month a given date falls in.
const firstMondayOfMonth = (clinicDate) => {
  const [y, m] = String(clinicDate).split('-').map(Number);
  const first = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  // Forward to Monday: 0 days if the 1st is already a Monday.
  return shiftDate(first, (ROTATION_DAY - weekdayOf(first) + 7) % 7);
};

// A known Monday, used to decide which Mondays are fortnight boundaries.
// 1 Jan 1970 was a Thursday, so the 5th was the first Monday.
const FORTNIGHT_EPOCH = '1970-01-05';

const daysBetween = (from, to) => {
  const toUtc = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
};

// ---------------------------------------------------------------------
// Period boundaries
// ---------------------------------------------------------------------
// The Monday that opened the period currently in force. A password set before
// this instant is expired.
const currentPeriodStart = (interval = DEFAULT_INTERVAL, now = new Date()) => {
  const today = clinicToday(now);

  if (interval === 'monthly') {
    const thisMonth = firstMondayOfMonth(today);
    // Early days of a month that does not start on a Monday still belong to
    // the period that opened last month — e.g. Sat 1 Aug, when the first
    // Monday is the 3rd. Without this the period would silently restart.
    return today < thisMonth
      ? firstMondayOfMonth(shiftDate(`${today.slice(0, 8)}01`, -1))
      : thisMonth;
  }

  const monday = mondayOnOrBefore(today);
  if (interval === 'fortnightly') {
    // Every other Monday, counted from a fixed epoch so the schedule is stable
    // and does not shift when the setting is toggled.
    const weeks = daysBetween(FORTNIGHT_EPOCH, monday) / 7;
    return weeks % 2 === 0 ? monday : shiftDate(monday, -7);
  }

  return monday; // weekly
};

// The Monday the current password lapses on. Always strictly in the future of
// the current period start — on a rotation Monday it points at the NEXT one,
// because today's rotation has already happened.
const nextRotationDate = (interval = DEFAULT_INTERVAL, now = new Date()) => {
  const start = currentPeriodStart(interval, now);

  if (interval === 'monthly') {
    // First Monday of the month after the one the period started in.
    const [y, m] = start.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1)); // m is 1-based, so this is +1
    return firstMondayOfMonth(nextMonth.toISOString().slice(0, 10));
  }

  return shiftDate(start, interval === 'fortnightly' ? 14 : 7);
};

// ---------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------
// Pure and flag-agnostic: "is this password older than the current period?"
// Callers decide whether the feature is on. Exported for tests.
const isPasswordExpired = (user, interval = DEFAULT_INTERVAL, now = new Date()) => {
  if (!ROTATING_ROLES.includes(user.role)) return false;
  // Never set by the user themselves — an admin-issued temp password. Expired
  // by definition: it is a password the user did not choose and the admin knows.
  if (!user.passwordChangedAt) return true;
  return new Date(user.passwordChangedAt) < clinicMidnight(currentPeriodStart(interval, now));
};

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

  return {
    enabled,
    interval,
    applies: true,
    mustChangePassword: isPasswordExpired(user, interval, now),
    expiresOn: nextRotationDate(interval, now),
    policyLabel: INTERVALS[interval].label,
  };
};

module.exports = {
  ENABLED_KEY,
  INTERVAL_KEY,
  ROTATING_ROLES,
  ROTATION_DAY_NAME,
  INTERVALS,
  DEFAULT_INTERVAL,
  isValidInterval,
  getRotationConfig,
  setRotationConfig,
  clearRotationCache,
  currentPeriodStart,
  nextRotationDate,
  isPasswordExpired,
  getRotationStatus,
};
