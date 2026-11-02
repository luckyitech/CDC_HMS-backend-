// =====================================================================
// Sign-in records (16 Oct 2026, Emu) — every sign-in and every failed attempt
// by a member of staff: where from, on what, and whether it looks wrong.
//
//   recordSignin(req, { user, outcome, method, failReason, emailTried })
//     Writes the row at once (address, device, clinic network or outside) and
//     returns it, so the session token can carry its id. Everything slower —
//     looking up where an outside address is, deciding whether the sign-in is
//     suspicious, alerting — runs AFTER the sign-in has been answered and can
//     never delay or fail it.
//
//   attachGps(req, body)
//     The browser's own location, when the clinic asks for it at sign-in.
//     Written once, onto the row named in the caller's own session token —
//     never a row id the browser chooses.
//
// Patients are not recorded (a different trust boundary — see
// services/activityLogService.js TRACKED_ROLES). Nothing here logs an address,
// an email or a name to the console; failures log the error message only.
// Rows are kept forever ("the system never forgets").
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clientIp, matchNetwork, isPublicIp } = require('../utils/ip');
const { deviceLabel } = require('../utils/deviceLabel');
const { getSigninSecurityConfig } = require('../utils/signinSecurityConfig');
const { successReasons, failedBurstReached, describeReasons } = require('../utils/signinFlags');
const { lookupIp } = require('./ipLookup');
const { TRACKED_ROLES } = require('./activityLogService');
const { sendHrNoticeEmail } = require('../utils/emailService');
const { canReceiveSigninAlerts, INTERNAL_ROLES } = require('../constants/permissions');
const { CLINIC_TZ } = require('../utils/clinicTime');

const { UserLoginLog, User, Notification } = db;

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || null;

// ---------------------------------------------------------------------
// Display — one wording for every screen and alert
// ---------------------------------------------------------------------

/** "Mombasa, Kenya" / "Kenya" / null */
const placeText = (row) => {
  const parts = [row.city, row.country || row.countryCode].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
};

/** "In clinic (Main) · Mac · Chrome" / "Outside · Mombasa, Kenya · Safaricom · Android · Chrome" */
const signinSummary = (row) => {
  const where = row.network === 'clinic'
    ? `In clinic${row.networkLabel && row.networkLabel !== 'Clinic' ? ` (${row.networkLabel})` : ''}`
    : row.network === 'outside' ? 'Outside the clinic' : null;
  return [where, placeText(row), row.isp, row.deviceLabel].filter(Boolean).join(' · ') || null;
};

const FAIL_TEXT = {
  unknown_account: 'no account with that email',
  inactive: 'account inactive',
  wrong_password: 'wrong password',
  outside_blocked: 'outside the clinic without remote access',
};

const whenText = (at) => new Date(at).toLocaleString('en-GB', {
  timeZone: CLINIC_TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

// ---------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------

const networkFor = (ip, networks) => {
  const hit = matchNetwork(ip, networks);
  if (hit) return { network: 'clinic', networkLabel: clip(hit.label, 60) };
  if (isPublicIp(ip)) return { network: 'outside', networkLabel: null };
  return { network: 'unknown', networkLabel: null };
};

/**
 * Record one sign-in attempt. Never throws; returns the row (or null).
 * A failed attempt passes `user` when the account exists, else `emailTried`.
 */
const recordSignin = async (req, {
  user = null, outcome = 'success', method = 'password', failReason = null, emailTried = null,
} = {}) => {
  try {
    // Patients are not recorded, signed in or not.
    if (user && !TRACKED_ROLES.has(user.role)) return null;
    if (!user && outcome === 'success') return null;

    const cfg = await getSigninSecurityConfig();
    const ip = clientIp(req);
    const ua = clip(req.headers?.['user-agent'], 512);
    const row = await UserLoginLog.create({
      userId: user?.id ?? null,
      name: user ? clip(fullName(user), 255) : null,
      role: user?.role ?? null,
      ipAddress: ip,
      loginAt: new Date(),
      method,
      outcome,
      failReason: outcome === 'failed' ? clip(failReason, 32) : null,
      emailTried: outcome === 'failed' ? clip(String(emailTried || '').trim().toLowerCase(), 255) : null,
      userAgent: ua,
      deviceLabel: clip(deviceLabel(ua || ''), 64),
      ...(ip ? networkFor(ip, cfg.networks) : { network: 'unknown', networkLabel: null }),
    });
    setImmediate(() => { enrich(row.id).catch((err) => console.error('SigninLog.enrich error:', err.message)); });
    return row;
  } catch (err) {
    console.error('SigninLog.record error:', err.message);
    return null;
  }
};

// ---------------------------------------------------------------------
// After the answer: place, flags, alerts
// ---------------------------------------------------------------------

const historyFor = async (row) => {
  const earlier = await UserLoginLog.findAll({
    where: { userId: row.userId, outcome: 'success', id: { [Op.lt]: row.id } },
    attributes: ['deviceLabel', 'countryCode'],
    raw: true,
  });
  return {
    hasBaseline: earlier.some((r) => r.deviceLabel),
    devices: new Set(earlier.map((r) => r.deviceLabel).filter(Boolean)),
    countries: new Set(earlier.map((r) => r.countryCode).filter(Boolean)),
  };
};

const recentFailures = async (row, windowMinutes) => {
  const since = new Date(new Date(row.loginAt).getTime() - windowMinutes * 60 * 1000);
  const who = row.userId ? { userId: row.userId } : { emailTried: row.emailTried };
  if (!row.userId && !row.emailTried) return 0;
  return UserLoginLog.count({
    where: { ...who, outcome: 'failed', loginAt: { [Op.gte]: since }, id: { [Op.lte]: row.id } },
  });
};

/**
 * Has this account (or typed email) already raised a burst alert inside the
 * window? A slow attacker keeps the sliding count at exactly N; without this
 * every further try would alert again.
 */
const burstAlreadyFlagged = async (row, windowMinutes) => {
  const since = new Date(new Date(row.loginAt).getTime() - windowMinutes * 60 * 1000);
  const who = row.userId ? { userId: row.userId } : { emailTried: row.emailTried };
  return (await UserLoginLog.count({
    where: { ...who, outcome: 'failed', flagged: true, loginAt: { [Op.gte]: since }, id: { [Op.ne]: row.id } },
  })) > 0;
};

/** The people who receive sign-in alerts: explicit holders + the main admin account. */
const alertRecipients = async () => {
  const staff = await User.findAll({
    where: { isActive: true, role: { [Op.in]: INTERNAL_ROLES } },
    attributes: ['id', 'firstName', 'lastName', 'email', 'role', 'permissions', 'deniedPermissions', 'staffType'],
  });
  return staff.filter((u) => canReceiveSigninAlerts(u));
};

const alertText = (row, reasons, cfg) => {
  const where = signinSummary(row) || row.ipAddress || 'an unknown address';
  if (row.outcome === 'failed') {
    const who = row.name || row.emailTried || 'an unknown account';
    return {
      title: `Repeated failed sign-ins — ${who}`,
      body: `${cfg.rules.failedCount} wrong sign-in attempts for ${who} within `
        + `${cfg.rules.failedWindowMinutes} minutes. The last was at ${whenText(row.loginAt)} `
        + `from ${where}${row.ipAddress ? ` (${row.ipAddress})` : ''}.`,
    };
  }
  return {
    title: `Suspicious sign-in — ${row.name || 'a member of staff'}`,
    body: `${row.name || 'A member of staff'} signed in at ${whenText(row.loginAt)} from ${where}`
      + `${row.ipAddress ? ` (${row.ipAddress})` : ''}. Flagged for: ${describeReasons(reasons)}. `
      + 'If this was not them, change their password and check the Sign-ins page.',
  };
};

const sendAlerts = async (row, reasons, cfg) => {
  if (!cfg.alertsEnabled || (!cfg.alertChannels.bell && !cfg.alertChannels.email)) return false;
  const people = await alertRecipients();
  if (!people.length) return false;
  const { title, body } = alertText(row, reasons, cfg);
  const link = `/admin/sign-ins?focus=${row.id}`;
  if (cfg.alertChannels.bell) {
    try {
      await Notification.bulkCreate(people.map((p) => ({
        type: row.outcome === 'failed' ? 'signin_failed_attempts' : 'signin_suspicious',
        category: 'security',
        title: clip(title, 255),
        body: clip(body, 5000),
        link,
        uploadedBy: 'CDC HMS',
        assignedDoctorId: p.id,
        isRead: false,
      })));
    } catch (err) {
      console.error('SigninLog.bell error:', err.message);
    }
  }
  if (cfg.alertChannels.email) {
    for (const p of people) {
      if (!p.email) continue;
      try {
        await sendHrNoticeEmail({ to: p.email, name: p.firstName, title, body, link });
      } catch (err) {
        console.error('SigninLog.email error:', err.message);
      }
    }
  }
  return true;
};

/** Look up an outside address, decide whether the attempt is suspicious, alert. */
const enrich = async (id) => {
  const row = await UserLoginLog.findByPk(id);
  if (!row) return;
  const cfg = await getSigninSecurityConfig();

  if (row.network === 'outside' && cfg.lookupEnabled && row.ipAddress) {
    const place = await lookupIp(row.ipAddress, { provider: cfg.lookupProvider, token: cfg.lookupToken });
    if (place) {
      await row.update({
        countryCode: place.countryCode, country: place.country, region: place.region,
        city: place.city, isp: place.isp,
      });
    }
  }

  let reasons = [];
  if (row.outcome === 'success' && row.userId) {
    reasons = successReasons({ signin: row, history: await historyFor(row), rules: cfg.rules, hours: cfg.hours });
  } else if (row.outcome === 'failed' && cfg.rules.failedAttempts) {
    const n = await recentFailures(row, cfg.rules.failedWindowMinutes);
    if (failedBurstReached({ rules: cfg.rules, recentFailures: n })
      && !(await burstAlreadyFlagged(row, cfg.rules.failedWindowMinutes))) reasons = ['failed_attempts'];
  }
  if (!reasons.length) return;

  // Claim the flag atomically: only the run that flips it sends the alert, so
  // a sign-in is never alerted twice.
  const [claimed] = await UserLoginLog.update(
    { flagged: true, flagReasons: clip(reasons.join(','), 255) },
    { where: { id: row.id, flagged: false } },
  );
  if (!claimed) return;
  if (await sendAlerts(row, reasons, cfg)) await UserLoginLog.update({ alertedAt: new Date() }, { where: { id: row.id } });
};

// ---------------------------------------------------------------------
// The device's own location (asked for after sign-in, if the clinic chose to)
// ---------------------------------------------------------------------

const GPS_STATUSES = ['given', 'declined', 'unavailable'];
const GPS_WINDOW_MINUTES = 10;

/** Returns true when written; false when there is nothing to write to. */
const attachGps = async (req, { status, lat, lng, accuracy } = {}) => {
  const sid = Number(req.user?.sid);
  if (!Number.isInteger(sid) || sid <= 0) return false;
  if (!GPS_STATUSES.includes(status)) {
    throw Object.assign(new Error("status must be 'given', 'declined' or 'unavailable'"), { status: 400 });
  }
  const changes = { gpsStatus: status, gpsAt: new Date() };
  if (status === 'given') {
    const la = Number(lat); const ln = Number(lng); const acc = Math.round(Number(accuracy));
    if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
      throw Object.assign(new Error('That is not a location.'), { status: 400 });
    }
    changes.gpsLat = la.toFixed(6);
    changes.gpsLng = ln.toFixed(6);
    changes.gpsAccuracy = Number.isFinite(acc) && acc >= 0 ? Math.min(acc, 1000000) : null;
  }
  // Only while the clinic asks for it, and only soon after signing in: a
  // session cannot add a location to its sign-in hours later.
  if ((await getSigninSecurityConfig()).gpsMode !== 'ask') return false;
  const since = new Date(Date.now() - GPS_WINDOW_MINUTES * 60 * 1000);
  // Written once — except that a late "given" may replace "unavailable" (the
  // person answered the browser's prompt after the page stopped waiting).
  const [n] = await UserLoginLog.update(changes, {
    where: {
      id: sid, userId: req.user.id, outcome: 'success', loginAt: { [Op.gte]: since },
      gpsStatus: status === 'given' ? { [Op.or]: [null, 'unavailable'] } : null,
    },
  });
  return n > 0;
};

module.exports = { recordSignin, attachGps, enrich, signinSummary, placeText, FAIL_TEXT };
