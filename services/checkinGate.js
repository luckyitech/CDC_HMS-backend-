// =====================================================================
// The check-in gate (2 Nov 2026, Emu): "the HMS will only allow log ins for
// those that have punched in — unless the HMS has granted a specific user
// access with or without attendance." The grant is "May sign in without
// checking in at the scanner" (hr.checkin.exempt) on the Permissions tab, with
// an optional end date (Users.checkinExemptUntil).
//
// Asked in two places, like the network lock (utils/networkLock.js):
//   - at sign-in (controllers/authController.js login): a held person gets 423
//     code CHECKIN_REQUIRED with a short-lived gate ticket. The sign-in page
//     asks again with the ticket (POST /api/auth/gate-check) — never by
//     re-sending the password, so waiting at the gate does not use up the
//     sign-in rate limit the whole clinic shares (one public address);
//   - on every request (middleware/auth.js): a session opened before the gate
//     applied (05:30, or yesterday) is held once it does. Answers that let the
//     person in are remembered briefly, so this costs a lookup a minute.
// A check-in-only pass (the entrance-tag phone, scope 'tap') is never gated —
// it is how a person checks in. A failed lookup never holds anyone.
//
// Never held (in this order, so the answer says why):
//   patient            patients never check in
//   admin              the main admin account — no one locks the clinic out
//   exempt             the grant, until its end date (inclusive)
//   closed             not a clinic day, or outside [opening − 2 h, closing]
//                      (phone requests at night, a Sunday) — the clinic's
//                      hours from HR Settings, holidays included
//   leave              on approved leave today
//   no_checkin_method  no scanner ID on a working scanner and no check-in
//                      phone — never lock out someone who has no way in
//   checked_in         a counted punch today (fingerprint, card, phone or HR's
//                      manual entry), or a night session still running; a
//                      lunch punch-out does not close the gate
//   scanner_offline    the person can only check in by fingerprint and their
//                      scanner is offline: let in, HR is told
// =====================================================================

const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const db = require('../models');
const { canSkipCheckin, isTrueAdmin, PERMISSIONS } = require('../constants/permissions');
const { clinicToday, clinicDatePlusDays, clinicMidnight } = require('../utils/clinicTime');
const { getHrConfig } = require('../utils/hrConfig');
const svc = require('./hrAttendanceService');
const { isOnline } = require('./scannerService');

const { StaffAttendance, StaffPunch, HrScanner, HrScannerUser, UserDevice } = db;

const COUNTABLE = ['open', 'closed', 'missed_checkout'];
const EARLY_HOURS = 2;          // the gate opens this long before the clinic does
const RETRY_SECONDS = 15;       // how often the sign-in page asks again
const TICKET_MINUTES = 15;      // how long the sign-in page may keep asking

const HELD_MESSAGE = 'Please check in at the scanner first. The HMS opens once you have checked in today.';

// Remembered answers, all small and per process. "Checked in" holds for ten
// minutes (HR voiding today's session is rare; it then counts within ten);
// any other open answer for one minute; a held answer is never remembered.
const remembered = new Map();
const CHECKED_IN_MS = 10 * 60 * 1000;
const OPEN_MS = 60 * 1000;
const remember = (userId, answer, now) => {
  if (remembered.size > 4000) remembered.clear();
  const ttl = answer.why === 'checked_in' ? CHECKED_IN_MS : OPEN_MS;
  remembered.set(userId, { answer, until: now.getTime() + ttl, date: clinicToday(now) });
};
/** Forget a person's remembered answer (their access just changed), or everyone's. */
const forgetAnswer = (userId) => (userId ? remembered.delete(userId) : remembered.clear());
const recalled = (userId, now) => {
  const hit = remembered.get(userId);
  return hit && hit.until > now.getTime() && hit.date === clinicToday(now) ? hit.answer : null;
};

/** Is the person's grant in force on this clinic date? */
const exemptOn = (user, date) => {
  if (!canSkipCheckin(user) || isTrueAdmin(user)) return false;
  const until = user.checkinExemptUntil ? String(user.checkinExemptUntil).slice(0, 10) : null;
  return !until || date <= until;
};

/** Is the gate open on this date at this moment for this person (clinic hours)? */
const gateHours = async (userId, date, now) => {
  const cfg = await getHrConfig();
  const expected = await svc.expectedFor(userId, date, cfg);
  if (!expected.startAt || !expected.endAt) return false;
  const from = new Date(expected.startAt).getTime() - EARLY_HOURS * 3600 * 1000;
  return now.getTime() >= from && now.getTime() <= new Date(expected.endAt).getTime();
};

/**
 * How this person can check in: the active scanners they are linked to (and
 * still enrolled on), and whether they have a working check-in phone.
 */
const checkinMethods = async (userId, now) => {
  const links = await HrScannerUser.findAll({
    where: { UserId: userId, status: 'linked', onScanner: true },
    attributes: ['scannerId'],
  });
  const scanners = links.length
    ? await HrScanner.findAll({ where: { id: { [Op.in]: links.map((l) => l.scannerId) }, status: 'active' }, attributes: ['id', 'label', 'lastSeenAt'] })
    : [];
  const phone = (await UserDevice.count({ where: { UserId: userId, revokedAt: null, expiresAt: { [Op.gt]: now } } })) > 0;
  return { scanners, phone };
};

/** Checked in today — or a night session from yesterday that is still running. */
const checkedInFor = async (userId, date, now) => {
  const today = await StaffAttendance.count({ where: { UserId: userId, clinicDate: date, status: { [Op.in]: COUNTABLE } } });
  if (today) return true;
  const midnight = clinicMidnight(date);
  const night = await StaffAttendance.findOne({
    where: { UserId: userId, clinicDate: clinicDatePlusDays(-1, now), status: { [Op.in]: COUNTABLE }, expectedOutAt: { [Op.gte]: midnight } },
    attributes: ['expectedOutAt'],
  });
  return !!night && now.getTime() <= new Date(night.expectedOutAt).getTime() + svc.OVERNIGHT_GRACE_HOURS * 3600 * 1000;
};

/**
 * Should this person be held at the gate now?
 * @param {object} user  a User row (role, permissions, deniedPermissions, checkinExemptUntil, firstName)
 * @returns {Promise<{ held: boolean, why: string, details?: object }>}
 */
const decide = async (user, now) => {
  if (!user || user.role === 'patient') return { held: false, why: 'patient' };
  if (isTrueAdmin(user)) return { held: false, why: 'admin' };
  const date = clinicToday(now);
  if (exemptOn(user, date)) return { held: false, why: 'exempt' };
  if (!(await gateHours(user.id, date, now))) return { held: false, why: 'closed' };
  if ((await svc.leaveDatesFor(user.id, date, date)).has(date)) return { held: false, why: 'leave' };
  const { scanners, phone } = await checkinMethods(user.id, now);
  if (!scanners.length && !phone) return { held: false, why: 'no_checkin_method' };
  if (await checkedInFor(user.id, date, now)) return { held: false, why: 'checked_in' };

  const online = scanners.filter((s) => isOnline(s, now));
  if (!phone && !online.length) return { held: false, why: 'scanner_offline' };

  const lastPunchAt = await StaffPunch.max('at', { where: { UserId: user.id, outcome: 'applied' } });
  return {
    held: true,
    why: 'not_checked_in',
    details: {
      firstName: user.firstName || null,
      scanner: online.length ? { label: online[0].label || 'Scanner', online: true } : null,
      phone,
      lastPunchAt: lastPunchAt || null,
      retrySeconds: RETRY_SECONDS,
    },
  };
};

const gateFor = async (user, now = new Date()) => {
  if (user && (user.role === 'patient' || isTrueAdmin(user))) return decide(user, now);
  const hit = user && recalled(user.id, now);
  if (hit) return hit;
  try {
    const answer = await decide(user, now);
    if (!answer.held) remember(user.id, answer, now);
    return answer;
  } catch (err) {
    // A failed lookup (settings, holidays, a table mid-migration) never locks
    // anyone out of the clinic's system.
    console.error('CheckinGate.decide error:', err.message);
    return { held: false, why: 'error' };
  }
};

// ---------------------------------------------------------------------
// The gate ticket: proof the password was right a moment ago, good only for
// asking the gate again. Never a session.
// ---------------------------------------------------------------------
const issueTicket = (user) => jwt.sign({ id: user.id, scope: 'gate' }, process.env.JWT_SECRET, { expiresIn: `${TICKET_MINUTES}m` });
const readTicket = (ticket) => {
  try {
    const t = jwt.verify(String(ticket || ''), process.env.JWT_SECRET);
    return t && t.scope === 'gate' && t.id ? t.id : null;
  } catch {
    return null;
  }
};

// HR hears once per person per clinic day that someone came in while their
// scanner was down (best-effort; never delays the sign-in).
const offlineTold = new Set();
const tellHrScannerOffline = (user, now = new Date()) => {
  const key = `${user.id}|${clinicToday(now)}`;
  if (offlineTold.has(key)) return;
  if (offlineTold.size > 2000) offlineTold.clear();
  offlineTold.add(key);
  setImmediate(async () => {
    try {
      const { notify, holdersOf } = require('./hrNotify');
      const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || `user #${user.id}`;
      const time = now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' });
      await notify('checkin_gate_offline', {
        recipients: (await holdersOf(PERMISSIONS.HR_VIEW)).filter((id) => id !== user.id),
        title: `Signed in without a check-in — ${name}`,
        body: `${name} signed in at ${time} while the fingerprint scanner was offline, so their check-in `
          + 'could not be confirmed. Their punch will arrive once the scanner is back.',
        link: '/hr/register',
      });
    } catch (err) {
      console.error('CheckinGate.tellHr error:', err.message);
    }
  });
};

module.exports = {
  gateFor, forgetAnswer, issueTicket, readTicket, tellHrScannerOffline,
  HELD_MESSAGE, EARLY_HOURS, RETRY_SECONDS, TICKET_MINUTES,
};
