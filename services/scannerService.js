// =====================================================================
// HR Suite — fingerprint scanner (ZKTeco K40), 17 Oct 2026.
//
// The relay on the attendance PC sends every new punch it reads from the
// scanner. Each is stored once (StaffPunches, unique per scanner + user number
// + time, so a re-send is harmless) with outcome 'pending', then processed:
//   - dated more than 10 minutes in the future → implausible (scanner clock)
//   - before the scanner's go-live              → before_golive (kept, not counted)
//   - scanner user not linked / ignored         → unlinked / ignored
//   - otherwise → applied to the linked person's day (punchService.rebuildDay)
// Linking a user, undoing a link, or moving go-live re-processes the affected
// punches, so nothing is lost while HR sets the scanner up.
//
// Matching (Emu, 17 Oct 2026): staff are enrolled with the number part of
// their HMS staff ID (EMP005 → 5). A scanner user whose number equals a staff
// number is PROPOSED; HR confirms with one click.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { getHrConfig } = require('../utils/hrConfig');
const punchSvc = require('./punchService');

const { sequelize, HrScanner, HrScannerUser, StaffPunch, StaffProfile, User } = db;

const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
// "Online" while the relay's one-minute heartbeat is this recent.
const ONLINE_WITHIN_MS = 5 * 60 * 1000;

const isOnline = (scanner, now = new Date()) =>
  !!scanner.lastSeenAt && now.getTime() - new Date(scanner.lastSeenAt).getTime() <= ONLINE_WITHIN_MS;

/** The scanner number an HMS staff ID stands for: 'EMP005' → '5'. */
const numberOfEmployeeId = (employeeId) => {
  const m = /^EMP0*(\d+)$/i.exec(String(employeeId || '').trim());
  return m ? m[1] : null;
};
/** A scanner number without leading zeros: '005' → '5'. */
const normalNo = (userNo) => String(userNo || '').trim().replace(/^0+(?=\d)/, '');

/** Get (or create, unlinked) the scanner user for a number. */
const scannerUserFor = async (scannerId, userNo, transaction) => {
  const [row] = await HrScannerUser.findOrCreate({
    where: { scannerId, userNo },
    defaults: { scannerId, userNo, status: 'unlinked' },
    transaction,
  });
  return row;
};

/** Rebuild a set of days ("userId|date" keys), each in its own transaction. */
const rebuildDays = async (keys, cfg) => {
  for (const key of keys) {
    const [userId, clinicDate] = key.split('|');
    await withRetry((transaction) =>
      punchSvc.rebuildDay({ userId: Number(userId), clinicDate, cfg, transaction }));
  }
};

const isDeadlock = (err) => /deadlock|lock wait timeout/i.test(String(err && (err.original?.code || err.message)));

/** Run fn in a transaction, retrying a deadlock twice. */
const withRetry = async (fn) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sequelize.transaction(fn);
    } catch (err) {
      if (attempt >= 2 || !isDeadlock(err)) throw err;
    }
  }
};

/**
 * Process one pending punch. The link is read inside the transaction (so an
 * unlink made meanwhile wins), and the row only changes while still pending.
 */
const processOne = async (scanner, row, cfg, now) => withRetry(async (transaction) => {
  const at = new Date(row.at);
  const link = await scannerUserFor(scanner.id, row.scannerUserNo, transaction);
  let outcome;
  if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) outcome = 'implausible';
  else if (at < new Date(scanner.goLiveAt)) outcome = 'before_golive';
  else if (link.status === 'ignored') outcome = 'ignored';
  else if (link.status !== 'linked' || !link.UserId) outcome = 'unlinked';
  else outcome = 'applied';
  // "Last punch" on the settings tab: never a date the scanner's clock got wrong.
  if (outcome !== 'implausible' && (!link.lastPunchAt || new Date(link.lastPunchAt) < at)) {
    await link.update({ lastPunchAt: at }, { transaction });
  }
  if (outcome !== 'applied') {
    await StaffPunch.update(
      { outcome, UserId: null, clinicDate: null, direction: null, attendanceId: null },
      { where: { id: row.id, outcome: 'pending' }, transaction },
    );
    return outcome;
  }
  const clinicDate = await punchSvc.clinicDateFor(link.UserId, at, transaction);
  const [changed] = await StaffPunch.update(
    { outcome, UserId: link.UserId, clinicDate, createdById: link.UserId },
    { where: { id: row.id, outcome: 'pending' }, transaction },
  );
  if (changed) await punchSvc.rebuildDay({ userId: link.UserId, clinicDate, cfg, transaction, now });
  return outcome;
});

/**
 * Process every pending punch of a scanner, oldest first. Returns a count per
 * outcome.
 */
const processPending = async (scanner, now = new Date()) => {
  const cfg = await getHrConfig();
  const counts = {};
  for (;;) {
    const rows = await StaffPunch.findAll({
      where: { scannerId: scanner.id, outcome: 'pending' },
      order: [['at', 'ASC'], ['id', 'ASC']],
      limit: 500,
    });
    if (!rows.length) break;
    let progressed = 0;
    for (const row of rows) {
      try {
        const outcome = await processOne(scanner, row, cfg, now);
        counts[outcome] = (counts[outcome] || 0) + 1;
        progressed += 1;
      } catch (err) {
        // One bad row must not hold up the rest: it stays pending and is
        // retried on the next batch or heartbeat (a minute later).
        console.error('HrScanner.processPending error:', err.message);
        counts.retry = (counts.retry || 0) + 1;
      }
    }
    if (!progressed) break;
  }
  const last = await StaffPunch.max('at', { where: { scannerId: scanner.id, outcome: { [Op.ne]: 'implausible' } } });
  if (last) await scanner.update({ lastPunchAt: last });
  return counts;
};

/**
 * Store a batch from the relay and process it. `punches` are already parsed:
 * [{ userNo, at: Date, verifyCode, source }]. Re-sent punches are ignored by
 * the unique index. Returns { received, stored, counts }.
 */
const ingestPunches = async (scanner, punches, now = new Date()) => {
  const rows = punches.map((p) => ({
    scannerId: scanner.id, scannerUserNo: p.userNo, at: p.at, verifyCode: p.verifyCode ?? null,
    source: p.source, outcome: 'pending',
  }));
  let stored = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const before = await StaffPunch.count({ where: { scannerId: scanner.id } });
    await StaffPunch.bulkCreate(chunk, { ignoreDuplicates: true });
    stored += (await StaffPunch.count({ where: { scannerId: scanner.id } })) - before;
  }
  const counts = await processPending(scanner, now);
  return { received: punches.length, stored, counts };
};

/**
 * After a link changes (linked, unlinked, ignored): move the user's punches
 * to match and rebuild every day they touch.
 */
const reprocessUser = async (scanner, link, previousUserId = null) => {
  const cfg = await getHrConfig();
  const where = { scannerId: scanner.id, scannerUserNo: link.userNo };
  const days = new Set();
  if (previousUserId) {
    const applied = await StaffPunch.findAll({ where: { ...where, outcome: 'applied' }, attributes: ['UserId', 'clinicDate'] });
    for (const p of applied) days.add(`${p.UserId}|${p.clinicDate}`);
  }
  await StaffPunch.update(
    { outcome: 'pending', UserId: null, clinicDate: null, direction: null, attendanceId: null },
    { where: { ...where, outcome: { [Op.in]: ['applied', 'unlinked', 'ignored'] } } },
  );
  await rebuildDays(days, cfg);   // the old person's days, without these punches
  return processPending(scanner);
};

/** After go-live moves: re-check every punch against it. */
const reprocessGoLive = async (scanner) => {
  const cfg = await getHrConfig();
  const goLive = new Date(scanner.goLiveAt);
  // Go-live moved later: punches now before it leave their days.
  const leaving = await StaffPunch.findAll({
    where: { scannerId: scanner.id, outcome: 'applied', at: { [Op.lt]: goLive } },
    attributes: ['id', 'UserId', 'clinicDate'],
  });
  if (leaving.length) {
    await StaffPunch.update(
      { outcome: 'before_golive', UserId: null, clinicDate: null, direction: null, attendanceId: null },
      { where: { id: { [Op.in]: leaving.map((p) => p.id) } } },
    );
    await rebuildDays(new Set(leaving.map((p) => `${p.UserId}|${p.clinicDate}`)), cfg);
  }
  // Go-live moved earlier: punches now after it are processed.
  await StaffPunch.update(
    { outcome: 'pending' },
    { where: { scannerId: scanner.id, outcome: 'before_golive', at: { [Op.gte]: goLive } } },
  );
  return processPending(scanner);
};

/**
 * The scanner's users for the HR settings tab: each with its link, the
 * proposed staff member (by staff number) and the punches waiting.
 */
const usersFor = async (scanner) => {
  const users = await HrScannerUser.findAll({
    where: { scannerId: scanner.id },
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'], include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department'], required: false }] }],
  });
  const waiting = await StaffPunch.findAll({
    where: { scannerId: scanner.id, outcome: 'unlinked' },
    attributes: ['scannerUserNo', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    group: ['scannerUserNo'], raw: true,
  });
  const waitingBy = new Map(waiting.map((w) => [w.scannerUserNo, Number(w.n)]));

  const profiles = await StaffProfile.findAll({
    where: { employeeId: { [Op.regexp]: '^EMP[0-9]+$' }, deletedAt: null },
    attributes: ['employeeId', 'UserId', 'position', 'department'],
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'], where: { isActive: true } }],
  });
  const byNumber = new Map(profiles.map((p) => [numberOfEmployeeId(p.employeeId), p]));
  const linkedIds = new Set(users.filter((u) => u.status === 'linked' && u.UserId).map((u) => u.UserId));

  const person = (user, profile) => (user ? {
    id: user.id, name: `${user.firstName} ${user.lastName}`, role: user.role,
    employeeId: profile?.employeeId || null, position: profile?.position || null,
  } : null);

  return users
    .map((u) => {
      const match = byNumber.get(normalNo(u.userNo));
      const proposal = u.status === 'unlinked' && match && !linkedIds.has(match.UserId)
        ? person(match.User, match) : null;
      return {
        id: u.id, userNo: u.userNo, name: u.name, status: u.status, onScanner: u.onScanner,
        lastPunchAt: u.lastPunchAt, linkedAt: u.linkedAt,
        person: u.status === 'linked' ? person(u.User, u.User?.StaffProfile) : null,
        proposal,
        noMatchingStaff: u.status === 'unlinked' && !match,
        waiting: waitingBy.get(u.userNo) || 0,
      };
    })
    .sort((a, b) => (Number(normalNo(a.userNo)) - Number(normalNo(b.userNo))) || a.userNo.localeCompare(b.userNo));
};

/** Active internal staff HR can link to a scanner ID (picker on the settings tab). */
const staffOptions = async () => {
  const { STAFF_ROLES } = require('../constants/staffRoles');
  const users = await User.findAll({
    where: { isActive: true, role: { [Op.in]: STAFF_ROLES } },
    attributes: ['id', 'firstName', 'lastName', 'role'],
    include: [{ model: StaffProfile, attributes: ['employeeId', 'position'], required: false }],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
  });
  return users.map((u) => ({
    id: u.id, name: `${u.firstName} ${u.lastName}`, role: u.role,
    employeeId: u.StaffProfile?.employeeId || null, position: u.StaffProfile?.position || null,
  }));
};

/** Store the relay's view of the scanner's user list (numbers and names only). */
const syncUserList = async (scanner, list) => {
  const seen = new Set();
  for (const u of list) {
    const row = await scannerUserFor(scanner.id, u.userNo);
    seen.add(row.id);
    const patch = { onScanner: true };
    if (u.name !== undefined && u.name !== row.name) patch.name = u.name || null;
    await row.update(patch);
  }
  await HrScannerUser.update({ onScanner: false }, { where: { scannerId: scanner.id, id: { [Op.notIn]: [...seen, 0] } } });
};

module.exports = {
  ONLINE_WITHIN_MS,
  isOnline,
  numberOfEmployeeId,
  normalNo,
  ingestPunches,
  processPending,
  reprocessUser,
  reprocessGoLive,
  usersFor,
  staffOptions,
  syncUserList,
};
