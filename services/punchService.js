// =====================================================================
// HR Suite — one session per person per day, rebuilt from every punch
// (fingerprint scanner, 17 Oct 2026).
//
// A punch (models/StaffPunch.js) is stored first; then the person's day is
// rebuilt from all their applied punches by utils/punchDay.buildDay: first
// counted punch = check-in, then out, in, out…; the day is checked out while
// its last counted punch is an "out". The NFC tap, the scanner relay and HR's
// manual entry all go through rebuildDay, so they agree.
//
// HR keeps the last word on what HR set: an amend stores diagnostics.hrLocked
// = { in, out }. A locked check-in stays as HR set it; a locked check-out (HR
// gave one) keeps the check-out and the status. What HR did not set still
// follows the punches — so a day HR re-opened closes at the person's next
// "out" (the last punch of the day).
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday, clinicMidnight, clinicDatePlusDays } = require('../utils/clinicTime');
const { punctuality } = require('../utils/attendanceRules');
const { buildDay, methodOf, verificationOf } = require('../utils/punchDay');
const { parseJsonColumn } = require('../utils/jsonColumn');
const svc = require('./hrAttendanceService');

const { StaffAttendance, StaffPunch, User } = db;

const COUNTABLE = ['open', 'closed', 'missed_checkout'];
const SOURCE_OF_METHOD = { nfc: 'nfc', fingerprint: 'fingerprint', card: 'card', manual: 'manual', code: 'manual' };

const plain = (row) => (row && row.get ? row.get({ plain: true }) : row);

/**
 * The clinic date a punch belongs to: its own date — or the evening before,
 * when that day's session is a rostered night shift (expected to end after
 * midnight) and the punch comes before its end + the overnight grace. Any
 * countable status counts, so a break in the night (out at 02:00, in at
 * 02:30) and punches processed late (a relay outage, a link made days later)
 * all stay on the night they belong to.
 */
const clinicDateFor = async (userId, at, transaction) => {
  const date = clinicToday(at);
  const midnight = clinicMidnight(date);
  const yesterday = clinicDatePlusDays(-1, new Date(midnight.getTime() + 12 * 3600 * 1000));
  const night = await StaffAttendance.findOne({
    where: { UserId: userId, clinicDate: yesterday, status: { [Op.in]: COUNTABLE }, expectedOutAt: { [Op.gte]: midnight } },
    attributes: ['id', 'expectedOutAt'],
    transaction,
  });
  if (night && new Date(at).getTime() <= new Date(night.expectedOutAt).getTime() + svc.OVERNIGHT_GRACE_HOURS * 3600 * 1000) return yesterday;
  return date;
};

/** HR's lock on a session: { in, out } (an older boolean lock = both). */
const lockOf = (diag) => {
  const l = diag && diag.hrLocked;
  if (!l) return { in: false, out: false };
  if (l === true) return { in: true, out: true };
  return { in: !!l.in, out: !!l.out };
};

/**
 * Sessions written before punches existed have no punches. Give each of them
 * punches for its check-in and check-out, once, so the day can be rebuilt
 * without losing them (the go-live day, or HR's older manual entries).
 */
const adoptLegacy = async (sessions, transaction) => {
  for (const s of sessions) {
    const diag = parseJsonColumn(s.diagnostics) || {};
    if (diag.punchModel) continue;
    const base = {
      UserId: s.UserId, clinicDate: s.clinicDate, outcome: 'applied', attendanceId: s.id,
      deviceId: s.deviceId || null, createdById: s.createdById || null, diagnostics: { adopted: true },
    };
    await StaffPunch.create({
      ...base, at: s.checkInAt, source: SOURCE_OF_METHOD[s.checkInMethod] || 'manual',
      tagId: s.checkInTagId || null, ip: s.checkInIp || null, lat: s.checkInLat, lng: s.checkInLng,
    }, { transaction });
    if (s.checkOutAt) {
      await StaffPunch.create({
        ...base, at: s.checkOutAt, source: SOURCE_OF_METHOD[s.checkOutMethod] || 'manual',
        tagId: s.checkOutTagId || null, ip: s.checkOutIp || null, lat: s.checkOutLat, lng: s.checkOutLng,
      }, { transaction });
    }
    // A session HR amended before punches were kept keeps HR's times (an HR
    // manual entry is HR's punches, so it is not locked).
    const legacyLock = s.amendedById && !diag.manual ? { hrLocked: { in: true, out: !!s.checkOutAt } } : {};
    await s.update({ diagnostics: { ...diag, ...legacyLock, punchModel: 1 } }, { transaction });
  }
};

/** Is an open day over (the sweep's rule: past date, night shift + 6 h)? */
const dayIsOver = (session, clinicDate, now) => {
  const today = clinicToday(now);
  if (!(clinicDate < today)) return false;
  const expectedOut = session && session.expectedOutAt ? new Date(session.expectedOutAt) : null;
  if (!expectedOut || clinicToday(expectedOut) < today) return true;
  return now.getTime() > expectedOut.getTime() + svc.OVERNIGHT_GRACE_HOURS * 3600 * 1000;
};

/**
 * The applied punches of one person's day, after adopting any legacy sessions.
 * Locks the person, then the day's sessions, when a transaction is given.
 */
const loadDay = async (userId, clinicDate, transaction) => {
  // One person's punches are processed one at a time: an NFC tap and a relay
  // batch for the same person wait for each other here (on their Users row)
  // instead of meeting in a gap lock on a session that does not exist yet.
  if (transaction) await User.findByPk(userId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  const sessions = await StaffAttendance.findAll({
    where: { UserId: userId, clinicDate, status: { [Op.in]: COUNTABLE } },
    order: [['checkInAt', 'ASC'], ['id', 'ASC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  await adoptLegacy(sessions, transaction);
  const punches = await StaffPunch.findAll({
    where: { UserId: userId, clinicDate, outcome: 'applied' },
    order: [['at', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  return { sessions, punches };
};

/** The counted punches of a day — what the tap decision needs. */
const countedFor = async (userId, clinicDate, cfg, transaction) => {
  const { punches } = await loadDay(userId, clinicDate, transaction);
  return buildDay(punches.map(plain), cfg).counted;
};

/**
 * Rebuild one person's day from its punches. Returns the session (or null
 * when the day has no counted punch) and the built day.
 *
 * @param {object} p
 * @param {number} p.userId
 * @param {string} p.clinicDate
 * @param {object} p.cfg          getHrConfig()
 * @param {object} [p.transaction]
 * @param {Date}   [p.now]
 */
const rebuildDay = async ({ userId, clinicDate, cfg, transaction, now = new Date() }) => {
  const { sessions, punches } = await loadDay(userId, clinicDate, transaction);
  const day = buildDay(punches.map(plain), cfg);

  // One session per day: older days may have several. Keep the one HR
  // locked, else the earliest; void the rest (kept for the audit trail, their
  // reason added to, never replaced) and move their punches over.
  let session = sessions.find((x) => lockOf(parseJsonColumn(x.diagnostics)).in) || sessions[0] || null;
  for (const extra of sessions.filter((x) => x !== session)) {
    const note = 'Merged into one session for the day (every punch is kept on that session).';
    await extra.update({
      status: 'voided', amendedAt: now,
      amendReason: extra.amendReason ? `${extra.amendReason} — ${note}` : note,
    }, { transaction });
  }

  if (!day.first) {
    // Every punch was removed (a scanner link undone): the session goes too,
    // unless HR amended it.
    if (session && !lockOf(parseJsonColumn(session.diagnostics)).in) {
      await session.update({ status: 'voided', amendedAt: now, amendReason: 'No punches left for this day (scanner link removed).' }, { transaction });
    }
    return { session: null, day };
  }

  const diag = session ? (parseJsonColumn(session.diagnostics) || {}) : {};

  const expected = session
    ? { startAt: session.expectedInAt, endAt: session.expectedOutAt, grace: await svc.graceOf(session, cfg), source: diag.hoursSource }
    : await svc.expectedFor(userId, clinicDate, cfg);
  const lock = session ? lockOf(diag) : { in: false, out: false };
  const first = day.first;
  const out = day.lastOut;
  const pIn = punctuality({ at: first.at, expectedAt: expected.startAt, graceMinutes: expected.grace, kind: 'in' });
  const pOut = out
    ? punctuality({ at: out.at, expectedAt: expected.endAt, graceMinutes: expected.grace, kind: 'out' })
    : { state: 'none', minutes: null };
  let status = 'closed';
  if (day.inside) status = dayIsOver(session || { expectedOutAt: expected.endAt }, clinicDate, now) ? 'missed_checkout' : 'open';

  const inFields = lock.in ? {} : {
    checkInAt: first.at,
    checkInMethod: methodOf(first.source),
    checkInVerification: verificationOf(first.source),
    checkInTagId: first.tagId || null,
    checkInIp: first.ip || null, checkInLat: first.lat ?? null, checkInLng: first.lng ?? null,
    checkInPunctuality: pIn.state,
    lateMinutes: pIn.state === 'late' ? pIn.minutes : (expected.startAt ? 0 : null),
  };
  const outFields = lock.out ? {} : {
    checkOutAt: out ? out.at : null,
    checkOutMethod: out ? methodOf(out.source) : null,
    checkOutVerification: out ? verificationOf(out.source) : null,
    checkOutTagId: out ? out.tagId || null : null,
    checkOutIp: out ? out.ip || null : null, checkOutLat: out ? out.lat ?? null : null, checkOutLng: out ? out.lng ?? null : null,
    checkOutPunctuality: pOut.state,
    earlyOutMinutes: pOut.state === 'early' ? pOut.minutes : (out && expected.endAt ? 0 : null),
    status,
  };
  const fields = {
    ...inFields,
    ...outFields,
    diagnostics: { ...diag, punchModel: 1, grace: expected.grace, hoursSource: diag.hoursSource || expected.source },
  };
  if (first.deviceId && !lock.in) fields.deviceId = first.deviceId;

  if (session) {
    await session.update(fields, { transaction });
  } else {
    session = await StaffAttendance.create({
      UserId: userId, clinicDate,
      expectedInAt: expected.startAt, expectedOutAt: expected.endAt,
      createdById: first.createdById || userId,
      ...fields,
    }, { transaction });
  }

  // Each punch remembers its direction (null = not counted) and its session.
  const ids = { in: [], out: [], none: [] };
  for (const p of day.punches) ids[p.direction || 'none'].push(p.id);
  for (const [dir, list] of Object.entries(ids)) {
    if (!list.length) continue;
    await StaffPunch.update(
      { direction: dir === 'none' ? null : dir, attendanceId: session.id },
      { where: { id: { [Op.in]: list } }, transaction },
    );
  }
  return { session, day };
};

/**
 * HR voided a session: its punches stop counting (outcome 'voided'), so the
 * person's next punch that day starts afresh instead of bringing it back.
 * Un-voiding restores them.
 */
const setSessionPunchesVoided = async (sessionId, voided, transaction) =>
  StaffPunch.update(
    voided ? { outcome: 'voided', direction: null } : { outcome: 'applied' },
    { where: { attendanceId: sessionId, outcome: voided ? 'applied' : 'voided' }, transaction },
  );

/** A day's punches as the register shows them (oldest first). */
const punchesForSession = async (sessionId) => {
  const rows = await StaffPunch.findAll({
    where: { attendanceId: sessionId },
    order: [['at', 'ASC'], ['id', 'ASC']],
    attributes: ['id', 'at', 'source', 'direction', 'outcome'],
  });
  return rows.map(plain);
};

module.exports = {
  clinicDateFor,
  loadDay,
  countedFor,
  rebuildDay,
  setSessionPunchesVoided,
  punchesForSession,
  lockOf,
};
