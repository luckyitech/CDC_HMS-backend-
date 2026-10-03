// Shift roster — the DB side (HR Tier 3 Phase 4; mockup D; T3-5/6/7 a,
// RO-1…RO-12). The ONE place a roster cell is set, copied or published; the
// rules are pure in utils/roster.
//
//   - Who a grid shows: active nurses, lab and front-office staff of ONE
//     department (or of no department), inside the viewer's hr.roster scope
//     (services/hrScope). A department outside the scope reads as not found.
//   - Draft → published (RO-4). Publishing makes every cell of the week from
//     today on the person's DATED working hours (StaffWorkHours, the rule
//     attendance already resolves — T3-5 a). In a published week a cell change
//     goes live at once. Days before today never change here (RO-5).
//   - Removing a live cell retires the working-hours row it wrote, so the
//     person's usual hours apply again (RO-6).
//   - Every live change is logged on the person's Activity tab (UserEditLog)
//     and the person hears of it (hrNotify roster_published / roster_changed),
//     with no detail beyond the week (RO-10).

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday, clinicDatePlusDays } = require('../utils/clinicTime');
const { PERMISSIONS } = require('../constants/permissions');
const { TAKEN_STATUSES } = require('../utils/leaveWorkflow');
const R = require('../utils/roster');
const hrScope = require('./hrScope');
const { holidayMap } = require('./leaveService');
const { writeUserEditLog } = require('./hrAttendanceService');
const hrNotify = require('./hrNotify');

const {
  sequelize, User, StaffProfile, Department, StaffLeave, StaffWorkHours,
  RosterShiftType, RosterWeek, RosterShift,
} = db;

class RosterError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

const HR_ROSTER = PERMISSIONS.HR_ROSTER;
const NO_DEPT = 'none';
const toHHMM = (t) => (t ? String(t).slice(0, 5) : null);
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** 'none' | '' | null → null; a number string → the id. */
const parseDepartment = (value) => {
  if (value === undefined || value === null || value === '' || value === NO_DEPT) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RosterError('Unknown department', 'BAD_DEPARTMENT');
  return n;
};

const checkWeekStart = (weekStart) => {
  if (!R.isMonday(weekStart)) throw new RosterError('A roster week starts on a Monday', 'BAD_WEEK');
  return weekStart;
};

// ---------------------------------------------------------------------------
// Shift types (hr.roster.shifts)
// ---------------------------------------------------------------------------

const shapeType = (t) => ({
  id: t.id, name: t.name, startTime: toHHMM(t.startTime), endTime: toHHMM(t.endTime),
  colour: t.colour, sortOrder: t.sortOrder, status: t.status,
  minutes: R.minutesOf({ startTime: toHHMM(t.startTime), endTime: toHHMM(t.endTime) }),
  overnight: R.isOvernight({ startTime: toHHMM(t.startTime), endTime: toHHMM(t.endTime) }),
});

const listTypes = async ({ all = false } = {}) => (await RosterShiftType.findAll({
  where: all ? {} : { status: 'active' }, order: [['sortOrder', 'ASC'], ['id', 'ASC']],
})).map(shapeType);

const TYPE_MESSAGES = {
  NAME_REQUIRED: 'Give the shift a name',
  NAME_TOO_LONG: 'Keep the name under 40 characters',
  BAD_TIME: 'Times must be HH:MM',
  SAME_TIME: 'The shift must start and end at different times',
  BAD_COLOUR: 'Choose one of the colours',
  BAD_ORDER: 'Order must be a whole number',
  BAD_STATUS: 'Status must be active or archived',
};

const createType = async (user, input) => {
  const c = R.cleanShiftType(input);
  if (c.error) throw new RosterError(TYPE_MESSAGES[c.error], c.error);
  const clash = await RosterShiftType.findOne({ where: { name: c.value.name, status: 'active' } });
  if (clash) throw new RosterError('A shift with that name already exists', 'NAME_EXISTS', 409);
  const max = await RosterShiftType.max('sortOrder');
  const row = await RosterShiftType.create({
    ...c.value, sortOrder: c.value.sortOrder ?? (Number(max) || 0) + 10, status: 'active', createdById: user.id,
  });
  return shapeType(row);
};

const updateType = async (user, id, input) => {
  const row = await RosterShiftType.findByPk(id);
  if (!row) throw new RosterError('Shift type not found', 'NOT_FOUND', 404);
  const c = R.cleanShiftType(input, { partial: true });
  if (c.error) throw new RosterError(TYPE_MESSAGES[c.error], c.error);
  const next = { ...shapeType(row), ...c.value };
  if (next.startTime === next.endTime) throw new RosterError(TYPE_MESSAGES.SAME_TIME, 'SAME_TIME');
  if (c.value.name && c.value.name !== row.name) {
    const clash = await RosterShiftType.findOne({ where: { name: c.value.name, status: 'active', id: { [Op.ne]: row.id } } });
    if (clash) throw new RosterError('A shift with that name already exists', 'NAME_EXISTS', 409);
  }
  const before = shapeType(row);
  await row.update(c.value);
  return { before, after: shapeType(row) };
};

// ---------------------------------------------------------------------------
// Who and where
// ---------------------------------------------------------------------------

/** The departments the viewer may open a roster for (+ "No department" for All-staff holders). */
const departmentsFor = async (user) => {
  const scope = await hrScope.scopeOf(user, HR_ROSTER);
  const rows = await Department.findAll({ where: { status: 'active' }, order: [['name', 'ASC']], attributes: ['id', 'name'] });
  const list = rows.filter((d) => scope.all || scope.departmentIds.has(d.id)).map((d) => ({ id: d.id, name: d.name }));
  if (scope.all) list.push({ id: NO_DEPT, name: 'No department' });
  return list;
};

/** May this viewer open this department's roster? (out of reach = not found) */
const assertDepartment = async (user, departmentId) => {
  const scope = await hrScope.scopeOf(user, HR_ROSTER);
  if (scope.all) {
    if (departmentId != null && !(await Department.findByPk(departmentId, { attributes: ['id'] }))) {
      throw new RosterError('Department not found', 'NOT_FOUND', 404);
    }
    return;
  }
  if (departmentId == null || !scope.departmentIds.has(departmentId)) throw new RosterError('Department not found', 'NOT_FOUND', 404);
};

/** The people a department's grid shows (T3-6 a), in the viewer's scope. */
const peopleFor = async (user, departmentId, { transaction } = {}) => {
  const ids = await hrScope.userIdsInScope(user, HR_ROSTER);
  const users = await User.findAll({
    where: {
      role: { [Op.in]: R.ROSTER_ROLES }, isActive: true,
      ...(ids === null ? {} : { id: { [Op.in]: ids } }),
    },
    attributes: ['id', 'firstName', 'lastName', 'role'],
    include: [{
      model: StaffProfile, required: false,
      attributes: ['employeeId', 'position', 'departmentId', 'deletedAt', 'employmentStatus'],
    }],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
    transaction,
  });
  return users.filter((u) => {
    const p = u.StaffProfile;
    if (p && p.deletedAt) return false;
    if (p && ['Suspended', 'Resigned', 'Terminated'].includes(p.employmentStatus)) return false;
    return (p?.departmentId ?? null) === departmentId;
  });
};

/** Approved leave in a date range for these people: Set 'userId|date'. Never the type (RO-7). */
const leaveSetFor = async (userIds, from, to, { transaction } = {}) => {
  const set = new Set();
  if (!userIds.length) return set;
  const leaves = await StaffLeave.findAll({
    where: { UserId: { [Op.in]: userIds }, status: { [Op.in]: TAKEN_STATUSES }, startDate: { [Op.lte]: to }, endDate: { [Op.gte]: from } },
    attributes: ['UserId', 'startDate', 'endDate'], transaction,
  });
  for (const l of leaves) {
    let d = String(l.startDate).slice(0, 10);
    const end = String(l.endDate).slice(0, 10);
    for (let i = 0; i < 400 && d <= end; i++) {
      if (d >= from && d <= to) set.add(`${l.UserId}|${d}`);
      d = R.addDays(d, 1);
    }
  }
  return set;
};

const weekRow = (departmentId, weekStart, { transaction, lock } = {}) => RosterWeek.findOne({
  where: { departmentId: departmentId ?? null, weekStart }, order: [['id', 'ASC']], transaction,
  lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
});

const ensureWeek = async (user, departmentId, weekStart, transaction) => {
  const found = await weekRow(departmentId, weekStart, { transaction, lock: true });
  if (found) return found;
  // A new week starts with last week's minimum cover (RO-8).
  const prev = await weekRow(departmentId, R.addDays(weekStart, -7), { transaction });
  return RosterWeek.create({
    departmentId: departmentId ?? null, weekStart, status: 'draft', minCover: prev ? prev.minCover : 0, createdById: user.id,
  }, { transaction });
};

const activeCells = (userIds, from, to, { transaction } = {}) => (userIds.length ? RosterShift.findAll({
  where: { UserId: { [Op.in]: userIds }, status: 'active', date: { [Op.between]: [from, to] } },
  include: [{ model: RosterShiftType, as: 'shiftType', attributes: ['id', 'name', 'colour'], required: false }],
  order: [['date', 'ASC']], transaction,
}) : []);

const shapeCell = (c) => ({
  id: c.id, UserId: c.UserId, date: String(c.date).slice(0, 10), shiftTypeId: c.shiftTypeId, isOff: !!c.isOff,
  startTime: toHHMM(c.startTime), endTime: toHHMM(c.endTime),
  name: c.isOff ? 'Off' : (c.shiftType?.name || 'Shift'), colour: c.isOff ? null : (c.shiftType?.colour || 'slate'),
  live: !!c.publishedAt, overnight: R.isOvernight({ isOff: c.isOff, startTime: toHHMM(c.startTime), endTime: toHHMM(c.endTime) }),
});

// ---------------------------------------------------------------------------
// Going live: a cell → the person's dated working hours (T3-5 a)
// ---------------------------------------------------------------------------

const unLive = async (cell, actorId, transaction) => {
  if (!cell.workHoursId) return;
  await StaffWorkHours.update({ status: 'retired', updatedById: actorId },
    { where: { id: cell.workHoursId, status: 'active' }, transaction });
};

const makeLive = async (cell, actorId, transaction) => {
  // The roster's word is the latest: any dated row for that day is retired first.
  await StaffWorkHours.update({ status: 'retired', updatedById: actorId },
    { where: { UserId: cell.UserId, date: cell.date, status: 'active' }, transaction });
  const wh = R.workHoursOf({ isOff: cell.isOff, startTime: toHHMM(cell.startTime), endTime: toHHMM(cell.endTime) });
  const row = await StaffWorkHours.create({
    UserId: cell.UserId, weekday: null, date: cell.date, ...wh, graceMinutes: null,
    status: 'active', createdById: actorId, updatedById: actorId,
  }, { transaction });
  await cell.update({ publishedAt: new Date(), workHoursId: row.id, updatedById: actorId }, { transaction });
};

const describe = (c) => (c.isOff ? 'Off' : `${c.name || 'Shift'} ${toHHMM(c.startTime)}–${toHHMM(c.endTime)}`);

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

const weekView = async (user, { department, weekStart }) => {
  const departmentId = parseDepartment(department);
  checkWeekStart(weekStart);
  await assertDepartment(user, departmentId);
  const today = clinicToday();
  const dates = R.weekDates(weekStart);
  const people = await peopleFor(user, departmentId);
  const ids = people.map((u) => u.id);
  const [week, cells, leave, holidays, types] = await Promise.all([
    weekRow(departmentId, weekStart),
    activeCells(ids, R.addDays(weekStart, -1), dates[6]),
    leaveSetFor(ids, dates[0], dates[6]),
    holidayMap(),
    listTypes({ all: true }),
  ]);
  const shaped = cells.map(shapeCell);
  const minCover = week ? week.minCover : ((await weekRow(departmentId, R.addDays(weekStart, -7)))?.minCover ?? 0);
  const warnings = R.warningsFor({ dates, cells: shaped, leave, minCover, people: ids });
  const inWeek = shaped.filter((c) => c.date >= dates[0]);
  const minutes = Object.fromEntries(ids.map((id) => [id, inWeek.filter((c) => c.UserId === id).reduce((n, c) => n + R.minutesOf(c), 0)]));
  let publishedBy = null;
  if (week?.publishedById) publishedBy = fullName(await User.findByPk(week.publishedById, { attributes: ['firstName', 'lastName'] }));
  return {
    department: departmentId ?? NO_DEPT,
    weekStart, dates, today,
    week: {
      status: week ? week.status : 'draft', minCover,
      publishedAt: week?.publishedAt || null, publishedBy,
    },
    people: people.map((u) => ({
      id: u.id, name: fullName(u), role: u.role,
      position: u.StaffProfile?.position || null, employeeId: u.StaffProfile?.employeeId || null,
      minutes: minutes[u.id] || 0,
    })),
    cells: inWeek,
    leave: [...leave].map((k) => { const [userId, date] = k.split('|'); return { userId: Number(userId), date }; }),
    holidays: Object.fromEntries(dates.filter((d) => holidays.has(d)).map((d) => [d, holidays.get(d)])),
    types: types.filter((t) => t.status === 'active'),
    warnings,
    unpublished: inWeek.filter((c) => !c.live && c.date >= today).length,
  };
};

/**
 * Set, change or clear one cell. body: { userId, date, shiftTypeId } | { userId, date, off: true } | { userId, date, clear: true }
 * @returns { cell|null, live:boolean, notify:[userId] }
 */
const setCell = async (user, { department, weekStart, userId, date, shiftTypeId, off, clear }) => {
  const departmentId = parseDepartment(department);
  checkWeekStart(weekStart);
  await assertDepartment(user, departmentId);
  const dates = R.weekDates(weekStart);
  if (!dates.includes(date)) throw new RosterError('That day is not in this week', 'BAD_DATE');
  if (date < clinicToday()) throw new RosterError('Days before today cannot be changed on the roster — amend attendance in the Time register', 'PAST_DAY');
  const people = await peopleFor(user, departmentId);
  const person = people.find((u) => u.id === Number(userId));
  if (!person) throw new RosterError('Person not found on this roster', 'NOT_FOUND', 404);

  let type = null;
  if (!clear && !off) {
    type = await RosterShiftType.findByPk(shiftTypeId);
    if (!type || type.status !== 'active') throw new RosterError('Choose one of the shifts', 'UNKNOWN_SHIFT');
  }

  const transaction = await sequelize.transaction();
  try {
    const week = await ensureWeek(user, departmentId, weekStart, transaction);
    const live = week.status === 'published';
    const old = await RosterShift.findOne({
      where: { UserId: person.id, date, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE,
      include: [{ model: RosterShiftType, as: 'shiftType', attributes: ['name'], required: false }],
    });
    const same = old && ((off && old.isOff) || (type && !old.isOff && old.shiftTypeId === type.id
      && toHHMM(old.startTime) === toHHMM(type.startTime) && toHHMM(old.endTime) === toHHMM(type.endTime)));
    if (same || (clear && !old)) {
      await transaction.commit();
      return { cell: old ? shapeCell(old) : null, live, changed: false };
    }
    if (old) {
      await unLive(old, user.id, transaction);
      await old.update({ status: 'removed', updatedById: user.id }, { transaction });
    }
    let cell = null;
    if (!clear) {
      cell = await RosterShift.create({
        UserId: person.id, date, shiftTypeId: type ? type.id : null, isOff: !!off,
        startTime: type ? toHHMM(type.startTime) : null, endTime: type ? toHHMM(type.endTime) : null,
        status: 'active', createdById: user.id, updatedById: user.id,
      }, { transaction });
      if (live) await makeLive(cell, user.id, transaction);
    }
    const wasLive = !!old?.publishedAt;
    if (live || wasLive) {
      const from = old ? describe({ ...old.get({ plain: true }), name: old.shiftType?.name }) : 'not rostered';
      const to = cell ? describe({ ...cell.get({ plain: true }), name: type?.name }) : 'not rostered (usual hours)';
      await writeUserEditLog({ targetUserId: person.id, actor: user, transaction, changes: { roster: { from: `${dayLabel(date)}: ${from}`, to } } });
    }
    await transaction.commit();
    if (live || wasLive) {
      hrNotify.notify('roster_changed', {
        recipients: [person.id], title: `Your shift on ${dayLabel(date)} has changed`,
        body: 'Open My profile in the HR Suite to see your shifts.', link: '/hr/me', actorName: fullName(user),
      }).catch(() => {});
    }
    if (cell) await cell.reload({ include: [{ model: RosterShiftType, as: 'shiftType', attributes: ['id', 'name', 'colour'], required: false }] });
    return { cell: cell ? shapeCell(cell) : null, live, changed: true };
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already done */ }
    throw err;
  }
};

/** Copy last week into the empty cells of this one, today onward (RO-9). */
const copyLastWeek = async (user, { department, weekStart }) => {
  const departmentId = parseDepartment(department);
  checkWeekStart(weekStart);
  await assertDepartment(user, departmentId);
  const dates = R.weekDates(weekStart);
  const people = await peopleFor(user, departmentId);
  const ids = people.map((u) => u.id);
  const [previous, existing, leave] = await Promise.all([
    activeCells(ids, R.addDays(weekStart, -7), R.addDays(weekStart, -1)),
    activeCells(ids, dates[0], dates[6]),
    leaveSetFor(ids, dates[0], dates[6]),
  ]);
  // A shift type archived since last week is not copied.
  const activeTypes = new Set((await RosterShiftType.findAll({ where: { status: 'active' }, attributes: ['id'] })).map((t) => t.id));
  const plan = R.copyPlan({
    previous: previous.map(shapeCell).filter((c) => c.isOff || activeTypes.has(c.shiftTypeId)),
    existing: existing.map(shapeCell), today: clinicToday(), leave, people: ids,
  });
  if (!plan.length) return { copied: 0 };

  const transaction = await sequelize.transaction();
  const touched = new Set();
  try {
    const week = await ensureWeek(user, departmentId, weekStart, transaction);
    const live = week.status === 'published';
    for (const p of plan) {
      const clash = await RosterShift.count({ where: { UserId: p.UserId, date: p.date, status: 'active' }, transaction });
      if (clash) continue;
      const cell = await RosterShift.create({ ...p, status: 'active', createdById: user.id, updatedById: user.id }, { transaction });
      if (live) { await makeLive(cell, user.id, transaction); touched.add(p.UserId); }
    }
    for (const uid of touched) {
      await writeUserEditLog({ targetUserId: uid, actor: user, transaction, changes: { roster: { from: null, to: `Week of ${dayLabel(weekStart)}: copied from last week` } } });
    }
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already done */ }
    throw err;
  }
  if (touched.size) {
    hrNotify.notify('roster_changed', {
      recipients: [...touched], title: `Your shifts for the week of ${dayLabel(weekStart)} have changed`,
      body: 'Open My profile in the HR Suite to see your shifts.', link: '/hr/me', actorName: fullName(user),
    }).catch(() => {});
  }
  return { copied: plan.length };
};

const setMinCover = async (user, { department, weekStart, minCover }) => {
  const departmentId = parseDepartment(department);
  checkWeekStart(weekStart);
  await assertDepartment(user, departmentId);
  const n = Number(minCover);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new RosterError('Minimum cover must be 0–50 people', 'BAD_COVER');
  const transaction = await sequelize.transaction();
  try {
    const week = await ensureWeek(user, departmentId, weekStart, transaction);
    await week.update({ minCover: n }, { transaction });
    await transaction.commit();
    return { minCover: n };
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already done */ }
    throw err;
  }
};

/**
 * Publish the week (RO-4): every cell from today on becomes the person's dated
 * working hours. One way. Publishing again makes live anything not yet live.
 */
const publish = async (user, { department, weekStart }) => {
  const departmentId = parseDepartment(department);
  checkWeekStart(weekStart);
  await assertDepartment(user, departmentId);
  const dates = R.weekDates(weekStart);
  const today = clinicToday();
  const people = await peopleFor(user, departmentId);
  const ids = people.map((u) => u.id);
  const transaction = await sequelize.transaction();
  const counts = new Map();
  try {
    const week = await ensureWeek(user, departmentId, weekStart, transaction);
    const cells = ids.length ? await RosterShift.findAll({
      where: { UserId: { [Op.in]: ids }, status: 'active', date: { [Op.between]: [today > dates[0] ? today : dates[0], dates[6]] }, publishedAt: null },
      transaction, lock: transaction.LOCK.UPDATE,
    }) : [];
    for (const c of cells) {
      await makeLive(c, user.id, transaction);
      counts.set(c.UserId, (counts.get(c.UserId) || 0) + 1);
    }
    if (week.status !== 'published') {
      await week.update({ status: 'published', publishedAt: new Date(), publishedById: user.id }, { transaction });
    }
    for (const [uid, n] of counts) {
      await writeUserEditLog({ targetUserId: uid, actor: user, transaction, changes: { roster: { from: null, to: `Week of ${dayLabel(weekStart)} published (${n} day${n === 1 ? '' : 's'})` } } });
    }
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch { /* already done */ }
    throw err;
  }
  if (counts.size) {
    hrNotify.notify('roster_published', {
      recipients: [...counts.keys()], title: `Your shifts for the week of ${dayLabel(weekStart)} are published`,
      body: 'Open My profile in the HR Suite to see your shifts.', link: '/hr/me', actorName: fullName(user),
    }).catch(() => {});
  }
  return { published: [...counts.values()].reduce((a, b) => a + b, 0), people: counts.size };
};

/** My published shifts, today and the next 13 days (RO-11). Drafts never show. */
const myShifts = async (userId, { days = 14 } = {}) => {
  const today = clinicToday();
  const to = clinicDatePlusDays(days - 1);
  const rows = await RosterShift.findAll({
    where: { UserId: userId, status: 'active', publishedAt: { [Op.ne]: null }, date: { [Op.between]: [today, to] } },
    include: [{ model: RosterShiftType, as: 'shiftType', attributes: ['id', 'name', 'colour'], required: false }],
    order: [['date', 'ASC']],
  });
  return { from: today, to, shifts: rows.map(shapeCell).map(({ UserId, live, ...c }) => c) };
};

module.exports = {
  RosterError, NO_DEPT, TYPE_MESSAGES,
  listTypes, createType, updateType, shapeType,
  departmentsFor, peopleFor, weekView, setCell, copyLastWeek, setMinCover, publish, myShifts,
};
