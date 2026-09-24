// HR Suite (B21) — per-person working hours (decision 9).
//
// GET  /api/hr/work-hours            everyone's active rows + the clinic default (hr.view)
// GET  /api/hr/work-hours/me         the caller's resolved week (hr.checkin)
// PUT  /api/hr/work-hours/:userId    replace a person's weekday pattern and/or add dated overrides (hr.write)
//
// Rows are retired, never deleted. "One active weekday row per person per
// weekday" is enforced here (the unique index cannot, over NULL columns).
const db = require('../models');
const { success, error } = require('../utils/response');
const { getHrConfig } = require('../utils/hrConfig');
const { HHMM, resolveExpected } = require('../utils/workHours');
const { clinicToday, clinicDatePlusDays } = require('../utils/clinicTime');
const svc = require('../services/hrAttendanceService');

const { sequelize, StaffWorkHours, User } = db;

const serialize = (r) => ({
  id: r.id, UserId: r.UserId, weekday: r.weekday, date: r.date,
  startTime: r.startTime ? String(r.startTime).slice(0, 5) : null,
  endTime: r.endTime ? String(r.endTime).slice(0, 5) : null,
  isOff: !!r.isOff, graceMinutes: r.graceMinutes, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, status: r.status,
});

/** The seven resolved days for a person (what the dashboard's "My working hours" shows). */
const resolvedWeek = (rows, cfg) => {
  const today = clinicToday();
  const week = [];
  for (let i = 0; i < 7; i++) {
    const date = clinicDatePlusDays(i, new Date());
    const exp = resolveExpected({ rows, clinicDate: date, defaults: cfg.hoursDefault, graceDefault: cfg.graceMinutes });
    week.push({ date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), start: exp.start, end: exp.end, grace: exp.grace, source: exp.source, isToday: date === today });
  }
  return week;
};

const listAll = async (req, res) => {
  try {
    const cfg = await getHrConfig();
    const users = await svc.internalUsers();
    const rows = await StaffWorkHours.findAll({ where: { status: 'active' }, order: [['UserId', 'ASC'], ['weekday', 'ASC'], ['date', 'ASC']] });
    const by = new Map();
    for (const r of rows) { const l = by.get(r.UserId) || []; l.push(serialize(r)); by.set(r.UserId, l); }
    return success(res, {
      hoursDefault: cfg.hoursDefault, graceMinutes: cfg.graceMinutes,
      people: users.filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt).map((u) => ({ person: svc.personOf(u), rows: by.get(u.id) || [] })),
    });
  } catch (err) {
    console.error('StaffWorkHours.listAll error:', err);
    return error(res, 'Failed to load working hours', 500);
  }
};

const mine = async (req, res) => {
  try {
    const cfg = await getHrConfig();
    const rows = await svc.workHoursRowsFor(req.user.id);
    return success(res, { hoursDefault: cfg.hoursDefault, graceMinutes: cfg.graceMinutes, rows: rows.map(serialize), week: resolvedWeek(rows, cfg) });
  } catch (err) {
    console.error('StaffWorkHours.mine error:', err);
    return error(res, 'Failed to load your working hours', 500);
  }
};

const validTime = (t) => t == null || t === '' || HHMM.test(t);

/**
 * PUT body: { weekdays: [{ weekday, startTime, endTime, isOff, graceMinutes }], overrides: [{ date, startTime, endTime, isOff, graceMinutes }] }
 * `weekdays` REPLACES the person's weekday pattern (rows for weekdays not listed
 * are retired → those days fall back to the clinic default). `overrides` are
 * added (an existing override for the same date is retired first). Either key
 * may be omitted to leave that part alone.
 */
const update = async (req, res) => {
  let transaction;
  try {
    const userId = parseInt(req.params.userId, 10);
    const target = await User.findByPk(userId, { attributes: ['id', 'role'] });
    if (!target || target.role === 'patient') return error(res, 'Staff member not found', 404);
    const { weekdays, overrides } = req.body;
    const check = (e, what) => {
      if (!validTime(e.startTime) || !validTime(e.endTime)) return `${what}: times must be HH:MM`;
      if (!e.isOff && e.startTime && e.endTime && e.startTime >= e.endTime) return `${what}: end must be after start`;
      if (e.graceMinutes != null && e.graceMinutes !== '' && !(Number(e.graceMinutes) >= 0 && Number(e.graceMinutes) <= 240)) return `${what}: grace must be 0–240 minutes`;
      return null;
    };
    if (weekdays !== undefined) {
      if (!Array.isArray(weekdays)) return error(res, 'weekdays must be a list', 400);
      const seen = new Set();
      for (const w of weekdays) {
        if (!(Number.isInteger(w.weekday) && w.weekday >= 0 && w.weekday <= 6)) return error(res, 'weekday must be 0 (Sunday) to 6 (Saturday)', 400);
        if (seen.has(w.weekday)) return error(res, 'Each weekday may appear once', 400);
        seen.add(w.weekday);
        const msg = check(w, `Weekday ${w.weekday}`); if (msg) return error(res, msg, 400);
      }
    }
    if (overrides !== undefined) {
      if (!Array.isArray(overrides)) return error(res, 'overrides must be a list', 400);
      for (const o of overrides) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date || '')) return error(res, 'An override needs a date (YYYY-MM-DD)', 400);
        const msg = check(o, o.date); if (msg) return error(res, msg, 400);
      }
    }

    transaction = await sequelize.transaction();
    const stamp = { updatedById: req.user.id };
    if (weekdays !== undefined) {
      await StaffWorkHours.update({ status: 'retired', ...stamp }, { where: { UserId: userId, date: null, status: 'active' }, transaction });
      for (const w of weekdays) {
        await StaffWorkHours.create({
          UserId: userId, weekday: w.weekday, date: null,
          startTime: w.isOff ? null : (w.startTime || null), endTime: w.isOff ? null : (w.endTime || null),
          isOff: !!w.isOff, graceMinutes: w.graceMinutes == null || w.graceMinutes === '' ? null : Number(w.graceMinutes),
          effectiveFrom: w.effectiveFrom || null, effectiveTo: w.effectiveTo || null,
          status: 'active', createdById: req.user.id, updatedById: req.user.id,
        }, { transaction });
      }
    }
    if (overrides !== undefined) {
      for (const o of overrides) {
        await StaffWorkHours.update({ status: 'retired', ...stamp }, { where: { UserId: userId, date: o.date, status: 'active' }, transaction });
        if (o.remove) continue;
        await StaffWorkHours.create({
          UserId: userId, weekday: null, date: o.date,
          startTime: o.isOff ? null : (o.startTime || null), endTime: o.isOff ? null : (o.endTime || null),
          isOff: !!o.isOff, graceMinutes: o.graceMinutes == null || o.graceMinutes === '' ? null : Number(o.graceMinutes),
          status: 'active', createdById: req.user.id, updatedById: req.user.id,
        }, { transaction });
      }
    }
    await svc.writeUserEditLog({
      targetUserId: userId, actor: req.user, transaction,
      changes: { workingHours: { from: null, to: `${weekdays ? `${weekdays.length} weekday rows` : ''}${weekdays && overrides ? ', ' : ''}${overrides ? `${overrides.length} dated overrides` : ''}` } },
    });
    await transaction.commit(); transaction = null;
    const cfg = await getHrConfig();
    const rows = await svc.workHoursRowsFor(userId);
    return success(res, { rows: rows.map(serialize), week: resolvedWeek(rows, cfg) });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch { /* ignore */ } }
    console.error('StaffWorkHours.update error:', err);
    return error(res, 'Failed to save working hours', 500);
  }
};

module.exports = { listAll, mine, update };
