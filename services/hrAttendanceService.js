// =====================================================================
// HR Suite (B21) — the database side of Time & Attendance.
//
// The rules live in utils/attendanceRules.js and utils/workHours.js (pure,
// tested); this file gathers rows and hands them to those functions, so the
// controllers stay thin and the sweep, the tap and the dashboard all compute
// a month the same way.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { resolveExpected, datesOfMonth, previousMonth } = require('../utils/workHours');
const { monthSummary, streakNoRed, clinicHHMM } = require('../utils/attendanceRules');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { STAFF_ROLES } = require('../constants/staffRoles');

const { StaffAttendance, StaffWorkHours, StaffLeave, User, StaffProfile, HrNfcTag, UserDevice, UserEditLog } = db;

/** A person's work-hours rows, once. */
const workHoursRowsFor = async (userId) =>
  (await StaffWorkHours.findAll({ where: { UserId: userId, status: 'active' } })).map((r) => r.get({ plain: true }));

/** Expected hours for one person on one clinic date. */
const expectedFor = async (userId, clinicDate, cfg, rows) => {
  const list = rows || await workHoursRowsFor(userId);
  return resolveExpected({ rows: list, clinicDate, defaults: cfg.hoursDefault, graceDefault: cfg.graceMinutes });
};

/** The clinic dates (Set) in [from, to] the person is on APPROVED leave. */
const leaveDatesFor = async (userId, from, to) => {
  const leaves = await StaffLeave.findAll({
    where: { UserId: userId, status: 'Approved', startDate: { [Op.lte]: to }, endDate: { [Op.gte]: from } },
    attributes: ['startDate', 'endDate'],
  });
  const set = new Set();
  for (const l of leaves) {
    const [y, m, d] = String(l.startDate).split('-').map(Number);
    const end = String(l.endDate);
    const cur = new Date(Date.UTC(y, m - 1, d));
    for (let i = 0; i < 400; i++) {
      const iso = cur.toISOString().slice(0, 10);
      if (iso > end) break;
      if (iso >= from && iso <= to) set.add(iso);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return set;
};

/** One entry per calendar date of a month, with expected hours and leave. */
const daysForMonth = async (userId, month, cfg, rows, leaveSet) => {
  const dates = datesOfMonth(month);
  const leave = leaveSet || await leaveDatesFor(userId, dates[0], dates[dates.length - 1]);
  return dates.map((date) => {
    const exp = resolveExpected({ rows, clinicDate: date, defaults: cfg.hoursDefault, graceDefault: cfg.graceMinutes });
    return { date, expectedStart: exp.start, expectedEnd: exp.end, onLeave: leave.has(date) };
  });
};

const plain = (row) => (row && row.get ? row.get({ plain: true }) : row);

/**
 * Everything the dashboard's "My stars" card and the tap page need for a
 * month: calendar, star counts, the table, the previous month's table and
 * the current streak (which may reach back into the previous month).
 */
const monthDataFor = async (userId, month, cfg, now = new Date()) => {
  const today = clinicToday(now);
  const prev = previousMonth(month);
  const rows = await workHoursRowsFor(userId);
  const [prevDays, curDays] = await Promise.all([
    daysForMonth(userId, prev, cfg, rows),
    daysForMonth(userId, month, cfg, rows),
  ]);
  const first = `${prev}-01`;
  const last = datesOfMonth(month).slice(-1)[0];
  const sessions = (await StaffAttendance.findAll({
    where: { UserId: userId, clinicDate: { [Op.between]: [first, last] }, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } },
    order: [['checkInAt', 'ASC']],
  })).map(plain);

  const current = monthSummary({ month, days: curDays, rows: sessions, today });
  const previous = monthSummary({ month: prev, days: prevDays, rows: sessions, today });
  const streak = streakNoRed({ days: [...prevDays, ...curDays], rows: sessions, today });
  return { ...current, streakNoRed: streak, previousMonth: { month: prev, stars: previous.stars, table: previous.table } };
};

/** The most recent countable session today (any status but refused/voided). */
const lastSessionToday = async (userId, clinicDate, transaction) =>
  StaffAttendance.findOne({
    where: { UserId: userId, clinicDate, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } },
    order: [['checkInAt', 'DESC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });

/** Has this person already earned an in-star today? (second check-in → none) */
const hasEarlierSessionToday = async (userId, clinicDate, transaction) =>
  (await StaffAttendance.count({ where: { UserId: userId, clinicDate, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } }, transaction })) > 0;

/** Internal (non-patient) active accounts with their profile bits. */
const internalUsers = async () =>
  User.findAll({
    where: { role: { [Op.in]: STAFF_ROLES }, isActive: true },
    attributes: ['id', 'firstName', 'lastName', 'role', 'email'],
    include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department', 'deletedAt'], required: false }],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
  });

const personOf = (user) => (user ? {
  id: user.id,
  name: `${user.firstName} ${user.lastName}`,
  firstName: user.firstName,
  role: user.role,
  employeeId: user.StaffProfile?.employeeId || null,
  position: user.StaffProfile?.position || null,
  department: user.StaffProfile?.department || null,
} : null);

const SESSION_INCLUDE = [
  { model: User, attributes: ['id', 'firstName', 'lastName', 'role'], include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department'], required: false }] },
  { model: User, as: 'amendedBy', attributes: ['id', 'firstName', 'lastName'] },
  { model: HrNfcTag, as: 'checkInTag', attributes: ['id', 'label', 'location'] },
  { model: HrNfcTag, as: 'checkOutTag', attributes: ['id', 'label', 'location'] },
  { model: UserDevice, as: 'device', attributes: ['id', 'label'] },
];

/** Minutes between check-in and check-out, or null while open. */
const minutesWorked = (row) => (row.checkOutAt ? Math.max(0, Math.round((new Date(row.checkOutAt) - new Date(row.checkInAt)) / 60000)) : null);

/** The shape every HR screen receives for a session row. */
const serializeSession = (row) => {
  const r = plain(row);
  return {
    id: r.id,
    clinicDate: r.clinicDate,
    checkInAt: r.checkInAt,
    checkOutAt: r.checkOutAt,
    checkInHHMM: clinicHHMM(r.checkInAt),
    checkOutHHMM: r.checkOutAt ? clinicHHMM(r.checkOutAt) : null,
    minutesWorked: r.status === 'closed' ? minutesWorked(r) : null,
    checkInMethod: r.checkInMethod,
    checkOutMethod: r.checkOutMethod,
    checkInVerification: r.checkInVerification,
    checkOutVerification: r.checkOutVerification,
    checkInPunctuality: r.checkInPunctuality,
    checkOutPunctuality: r.checkOutPunctuality,
    lateMinutes: r.lateMinutes,
    earlyOutMinutes: r.earlyOutMinutes,
    expectedInAt: r.expectedInAt,
    expectedOutAt: r.expectedOutAt,
    expectedInHHMM: r.expectedInAt ? clinicHHMM(r.expectedInAt) : null,
    expectedOutHHMM: r.expectedOutAt ? clinicHHMM(r.expectedOutAt) : null,
    status: r.status,
    checkInIp: r.checkInIp,
    checkOutIp: r.checkOutIp,
    door: r.checkInTag ? r.checkInTag.label : null,
    doorOut: r.checkOutTag ? r.checkOutTag.label : null,
    device: r.device ? r.device.label : null,
    diagnostics: parseJsonColumn(r.diagnostics),
    amendedAt: r.amendedAt,
    amendReason: r.amendReason,
    amendedBy: r.amendedBy ? `${r.amendedBy.firstName} ${r.amendedBy.lastName}` : null,
    person: personOf(r.User),
  };
};

/** Revoke every remembered phone for a user (deactivation / archive). */
const revokeUserDevices = async (userId, byId, transaction) =>
  UserDevice.update({ revokedAt: new Date(), revokedById: byId || null },
    { where: { UserId: userId, revokedAt: null }, transaction });

/** An entry on the person's Activity tab (the same log the staff file writes). */
const writeUserEditLog = async ({ targetUserId, actor, changes, transaction }) =>
  UserEditLog.create({
    targetUserId,
    editedBy: actor.id,
    editedByName: actor.name || `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || `user #${actor.id}`,
    changes,
    editedAt: new Date(),
  }, { transaction });

module.exports = {
  workHoursRowsFor,
  expectedFor,
  leaveDatesFor,
  daysForMonth,
  monthDataFor,
  lastSessionToday,
  hasEarlierSessionToday,
  internalUsers,
  personOf,
  SESSION_INCLUDE,
  serializeSession,
  minutesWorked,
  revokeUserDevices,
  writeUserEditLog,
};
