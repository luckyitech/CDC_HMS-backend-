// Leave settings — HR's side of leave (B27 phase 1; spec §6 "HR", mockup 1 +
// revision A). Mounted at /api/leave by routes/leave.js, every route gated
// leave.policy.
//
//   Leave policy     one per year — draft until published; copy from last year
//   Leave types      HR adds types by name; the seven system types can be
//                    renamed but never retired
//   Public holidays  a dated list; retired, never deleted
//   Entitlements     every member of staff × leave type for a year, and the
//                    per-person override (days, carried in, own week) with a
//                    reason
//
// What is and isn't allowed lives in utils/leavePolicyRules (pure, tested);
// balances come from services/leaveService so this screen shows exactly the
// numbers the staff file and the wizards will.
//
// Every change is recorded: policy, types and holidays in SettingChangeLogs
// (area "Leave policy" — the Recent changes list on the screen and the
// Activity Log), and an entitlement change also on the person's own Activity
// tab (UserEditLog).

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { recordSettingChanges } = require('../services/settingChangeLog');
const leaveService = require('../services/leaveService');
const { writeUserEditLog, internalUsers, personOf } = require('../services/hrAttendanceService');
const rules = require('../utils/leavePolicyRules');
const sequelize = require('../config/database');
const db = require('../models');

const {
  LeavePolicy, LeavePolicyType, LeaveType, PublicHoliday, LeaveBalance, SettingChangeLog, StaffProfile, User,
} = db;

const AREA = 'Leave policy';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const nameOf = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);
const showDays = (v) => (v === null || v === undefined ? 'no limit' : String(Number(v)));
const showWeight = (v) => (Number(v) === 0.5 ? '½' : String(Number(v)));
const showWeek = (w) => (w ? [1, 2, 3, 4, 5, 6, 0].map((d) => `${DAY_NAMES[d]} ${showWeight(w[d] ?? w[String(d)] ?? 0)}`).join(' · ') : '—');
const yearParam = (req) => {
  const y = parseInt(req.params.year, 10);
  return Number.isInteger(y) && y >= 2020 && y <= 2100 ? y : null;
};

/** The year's policy row (draft or published) with who published it. */
const findPolicyRow = (year, transaction) => LeavePolicy.findOne({
  where: { year },
  include: [{ model: User, as: 'publishedBy', attributes: ['id', 'firstName', 'lastName'] }],
  transaction,
});

/**
 * A policy as the screen needs it: settings, one row per ACTIVE type (a type
 * the year has no row for yet is filled with "switched off, no limit" and
 * marked `missing`), and what may be done to it today.
 */
const policyView = async (year) => {
  const today = clinicToday();
  const [row, policy, types, overrides, holidays, prev] = await Promise.all([
    findPolicyRow(year),
    leaveService.loadPolicy(year, { publishedOnly: false }),
    leaveService.listTypes(),
    LeaveBalance.count({
      where: { year, [Op.or]: [{ entitled: { [Op.ne]: null } }, { carriedOver: { [Op.ne]: null } }] },
      distinct: true, col: 'UserId',
    }),
    PublicHoliday.count({ where: { status: 'active', date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } } }),
    LeavePolicy.findOne({ where: { year: year - 1 }, attributes: ['id', 'status'] }),
  ]);
  const edit = rules.editability({ year, today, policy: row ? { status: row.status } : null });

  return {
    year,
    today,
    exists: !!row,
    editability: edit,
    previousYear: prev ? { year: year - 1, status: prev.status } : null,
    overridePeople: overrides,
    holidayCount: holidays,
    policy: policy && {
      status: policy.status,
      weekWeights: policy.weekWeights,
      countingMode: policy.countingMode,
      excludeHolidays: true,
      allowNegative: policy.allowNegative,
      proRate: policy.proRate,
      carryExpiry: policy.carryExpiry,
      minNoticeDays: policy.minNoticeDays,
      maxCadreAwayPerDay: policy.maxCadreAwayPerDay,
      blockDoctorSlots: policy.blockDoctorSlots,
      visibleTypes: Array.isArray(policy.visibleTypes) ? policy.visibleTypes : types.map((t) => t.key),
      publishedAt: policy.publishedAt,
      publishedBy: nameOf(row?.publishedBy),
    },
    types: types.map((t) => {
      const r = policy?.types?.[t.key];
      return {
        id: t.id,
        key: t.key,
        name: t.name,
        isSystem: t.isSystem,
        missing: !r,
        row: r || {
          days: null, countedAs: 'working', grant: 'unlimited', carryCap: 0, halfDaysAllowed: false,
          docRule: 'never', docOverDays: null, minNoticeDays: null, enabled: false,
        },
      };
    }),
  };
};

/** A policy flattened for the change log: { field: shown value }, plus labels. */
const flatten = (year, p, typeNames) => {
  const flat = {};
  const fields = {};
  const add = (field, label, value) => { flat[field] = value; fields[field] = { key: `leave.policy.${year}.${field}`, label: `${year} · ${label}` }; };
  if (!p) return { flat, fields };
  add('status', 'Status', p.status);
  add('weekWeights', 'Weekday values', showWeek(p.weekWeights));
  add('countingMode', 'Counting', p.countingMode === 'own_hours' ? "Each person's own hours" : 'Clinic week');
  add('allowNegative', 'Allow negative balance', !!p.allowNegative);
  add('proRate', 'Pro-rate joiners and leavers', !!p.proRate);
  add('carryExpiry', 'Carried days expire', p.carryExpiry || 'never');
  add('minNoticeDays', 'Minimum notice (days)', p.minNoticeDays ?? 0);
  add('maxCadreAwayPerDay', 'Most of one cadre away per day', p.maxCadreAwayPerDay ?? 'no warning');
  add('blockDoctorSlots', "Block a doctor's slots on approval", !!p.blockDoctorSlots);
  add('visibleTypes', 'Types staff can see', (p.visibleTypes || []).map((k) => typeNames[k] || k));
  for (const [key, t] of Object.entries(p.types || {})) {
    const n = typeNames[key] || key;
    add(`type.${key}.enabled`, `${n} · switched on`, !!t.enabled);
    add(`type.${key}.days`, `${n} · days`, showDays(t.days));
    add(`type.${key}.countedAs`, `${n} · counted as`, t.countedAs);
    add(`type.${key}.grant`, `${n} · granted`, t.grant);
    add(`type.${key}.carryCap`, `${n} · carry cap`, Number(t.carryCap || 0));
    add(`type.${key}.halfDaysAllowed`, `${n} · half days`, !!t.halfDaysAllowed);
    add(`type.${key}.docRule`, `${n} · needs a document`, t.docRule === 'over_days' ? `over ${Number(t.docOverDays)} days` : t.docRule);
    add(`type.${key}.minNoticeDays`, `${n} · notice (days)`, t.minNoticeDays ?? 'clinic default');
  }
  return { flat, fields };
};

const typeNameMap = async () =>
  Object.fromEntries((await leaveService.listTypes({ includeRetired: true })).map((t) => [t.key, t.name]));

/**
 * Logs the difference between two loadPolicy() snapshots. A year that had no
 * policy gets ONE line ("Draft started …") rather than a line per field —
 * the whole policy is on the screen; the trail records the event.
 */
const logPolicyChange = async (req, year, before, after, { startedFrom = null } = {}) => {
  if (!before && after) {
    recordSettingChanges({
      user: req.user, area: AREA, before: { p: null }, after: { p: startedFrom ? `Draft copied from ${startedFrom}` : 'Draft started' },
      fields: { p: { key: `leave.policy.${year}`, label: `${year} · Policy` } },
    });
    return;
  }
  const names = await typeNameMap();
  const a = flatten(year, before, names);
  const b = flatten(year, after, names);
  recordSettingChanges({ user: req.user, area: AREA, before: a.flat, after: b.flat, fields: { ...a.fields, ...b.fields } });
};

/** Writes a clean policy (from validatePolicy) into the year's rows. */
const writePolicy = async ({ year, value, actorId, transaction }) => {
  const settings = {
    weekWeights: value.weekWeights,
    countingMode: value.countingMode,
    excludeHolidays: true,
    allowNegative: value.allowNegative,
    proRate: value.proRate,
    carryExpiry: value.carryExpiry,
    minNoticeDays: value.minNoticeDays,
    maxCadreAwayPerDay: value.maxCadreAwayPerDay,
    blockDoctorSlots: value.blockDoctorSlots,
    ...(value.visibleTypes ? { visibleTypes: value.visibleTypes } : {}),
  };
  let row = await LeavePolicy.findOne({ where: { year }, transaction, lock: transaction.LOCK.UPDATE });
  if (row) await row.update({ ...settings, updatedBy: actorId }, { transaction });
  else row = await LeavePolicy.create({ year, status: 'draft', ...settings, createdBy: actorId, updatedBy: actorId }, { transaction });

  const typeRows = await LeaveType.findAll({ where: { key: Object.keys(value.types) }, transaction });
  const idOf = Object.fromEntries(typeRows.map((t) => [t.key, t.id]));
  for (const [key, t] of Object.entries(value.types)) {
    const leaveTypeId = idOf[key];
    if (!leaveTypeId) continue;
    const existing = await LeavePolicyType.findOne({ where: { policyId: row.id, leaveTypeId }, transaction });
    const data = {
      days: t.days ?? null, countedAs: t.countedAs, grant: t.grant, carryCap: t.carryCap ?? 0,
      halfDaysAllowed: t.halfDaysAllowed, docRule: t.docRule, docOverDays: t.docOverDays ?? null,
      minNoticeDays: t.minNoticeDays ?? null, enabled: t.enabled,
    };
    if (existing) await existing.update(data, { transaction });
    else await LeavePolicyType.create({ policyId: row.id, leaveTypeId, ...data }, { transaction });
  }
  return row;
};

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** GET /api/leave/policies — every year that has a policy, plus what can be started. */
const listPolicies = async (req, res) => {
  try {
    const today = clinicToday();
    const thisYear = Number(today.slice(0, 4));
    const rows = await LeavePolicy.findAll({
      attributes: ['id', 'year', 'status', 'publishedAt'],
      include: [{ model: User, as: 'publishedBy', attributes: ['id', 'firstName', 'lastName'] }],
      order: [['year', 'DESC']],
    });
    const have = new Set(rows.map((r) => r.year));
    const years = rows.map((r) => ({ year: r.year, status: r.status, publishedAt: r.publishedAt, publishedBy: nameOf(r.publishedBy) }));
    for (let y = thisYear; y <= thisYear + rules.YEARS_AHEAD; y++) {
      if (!have.has(y)) years.push({ year: y, status: 'none', publishedAt: null, publishedBy: null });
    }
    years.sort((a, b) => b.year - a.year);
    return success(res, { today, thisYear, years });
  } catch (err) {
    console.error('LeavePolicy.list error:', err);
    return error(res, 'Failed to load leave policies', 500);
  }
};

/** GET /api/leave/policy/:year */
const getPolicy = async (req, res) => {
  const year = yearParam(req);
  if (!year) return error(res, 'Choose a year.', 400);
  try {
    return success(res, await policyView(year));
  } catch (err) {
    console.error('LeavePolicy.get error:', err);
    return error(res, 'Failed to load the leave policy', 500);
  }
};

/**
 * PUT /api/leave/policy/:year — save the policy (draft, or a published
 * policy for a year that has not ended). Creates the year's draft when none
 * exists yet.
 */
const savePolicy = async (req, res) => {
  const year = yearParam(req);
  if (!year) return error(res, 'Choose a year.', 400);
  try {
    const existing = await LeavePolicy.findOne({ where: { year }, attributes: ['status'] });
    const edit = rules.editability({ year, today: clinicToday(), policy: existing ? { status: existing.status } : null });
    if (!edit.canEdit && !edit.canCreate) return error(res, edit.reason, 409, { code: edit.code });

    const activeKeys = (await leaveService.listTypes()).map((t) => t.key);
    const { ok, errors, value } = rules.validatePolicy(req.body || {}, { activeKeys });
    if (!ok) return error(res, errors[0], 400, { code: 'POLICY_INVALID', errors });

    const before = await leaveService.loadPolicy(year, { publishedOnly: false });
    await sequelize.transaction((t) => writePolicy({ year, value, actorId: req.user.id, transaction: t }));
    const after = await leaveService.loadPolicy(year, { publishedOnly: false });
    await logPolicyChange(req, year, before, after);
    return success(res, await policyView(year));
  } catch (err) {
    console.error('LeavePolicy.save error:', err);
    return error(res, 'Failed to save the leave policy', 500);
  }
};

/**
 * POST /api/leave/policy/:year/publish — from here on the year's leave is
 * counted by this policy (weekday values, holidays, half days, pro-rata,
 * carry-over). There is no "unpublish": a published year is corrected by
 * editing it (until the year ends) or with per-person overrides.
 */
const publishPolicy = async (req, res) => {
  const year = yearParam(req);
  if (!year) return error(res, 'Choose a year.', 400);
  try {
    const row = await LeavePolicy.findOne({ where: { year } });
    const edit = rules.editability({ year, today: clinicToday(), policy: row ? { status: row.status } : null });
    if (!row) return error(res, `There is no ${year} policy to publish yet — save a draft first.`, 404, { code: 'NO_POLICY' });
    if (row.status === 'published') return error(res, `The ${year} policy is already published.`, 409, { code: 'ALREADY_PUBLISHED' });
    if (!edit.canPublish) return error(res, edit.reason, 409, { code: edit.code });

    const activeKeys = (await leaveService.listTypes()).map((t) => t.key);
    const policy = await leaveService.loadPolicy(year, { publishedOnly: false });
    const problems = rules.publishProblems(policy, activeKeys);
    if (problems.length) return error(res, problems[0], 400, { code: 'POLICY_INCOMPLETE', errors: problems });

    await row.update({ status: 'published', publishedAt: new Date(), publishedById: req.user.id, updatedBy: req.user.id });
    recordSettingChanges({
      user: req.user, area: AREA,
      before: { status: 'draft' }, after: { status: 'published' },
      fields: { status: { key: `leave.policy.${year}.status`, label: `${year} · Status` } },
    });
    return success(res, await policyView(year));
  } catch (err) {
    console.error('LeavePolicy.publish error:', err);
    return error(res, 'Failed to publish the leave policy', 500);
  }
};

/**
 * POST /api/leave/policy/:year/copy-from/:prev — start (or overwrite a DRAFT
 * of) `year` from another year's policy. Holidays are dated, so they are not
 * copied; a published target is refused.
 */
const copyPolicy = async (req, res) => {
  const year = yearParam(req);
  const from = parseInt(req.params.prev, 10);
  if (!year || !Number.isInteger(from)) return error(res, 'Choose both years.', 400);
  if (from === year) return error(res, 'Choose a different year to copy from.', 400);
  try {
    const target = await LeavePolicy.findOne({ where: { year }, attributes: ['status'] });
    const edit = rules.editability({ year, today: clinicToday(), policy: target ? { status: target.status } : null });
    if (!edit.canEdit && !edit.canCreate) return error(res, edit.reason, 409, { code: edit.code });
    if (target && target.status === 'published') {
      return error(res, `The ${year} policy is already published — edit it instead of copying over it.`, 409, { code: 'ALREADY_PUBLISHED' });
    }
    const source = await leaveService.loadPolicy(from, { publishedOnly: false });
    if (!source) return error(res, `There is no ${from} policy to copy.`, 404, { code: 'NO_POLICY' });

    const activeKeys = (await leaveService.listTypes()).map((t) => t.key);
    const body = {
      weekWeights: source.weekWeights,
      countingMode: source.countingMode,
      allowNegative: source.allowNegative,
      proRate: source.proRate,
      carryExpiry: source.carryExpiry,
      minNoticeDays: source.minNoticeDays,
      maxCadreAwayPerDay: source.maxCadreAwayPerDay,
      blockDoctorSlots: source.blockDoctorSlots,
      visibleTypes: (Array.isArray(source.visibleTypes) ? source.visibleTypes : activeKeys).filter((k) => activeKeys.includes(k)),
      types: Object.fromEntries(Object.entries(source.types).filter(([k]) => activeKeys.includes(k))),
    };
    const { ok, errors, value } = rules.validatePolicy(body, { activeKeys });
    if (!ok) return error(res, `The ${from} policy can't be copied as it stands: ${errors[0]}`, 400, { code: 'POLICY_INVALID', errors });

    const before = await leaveService.loadPolicy(year, { publishedOnly: false });
    await sequelize.transaction((t) => writePolicy({ year, value, actorId: req.user.id, transaction: t }));
    const after = await leaveService.loadPolicy(year, { publishedOnly: false });
    await logPolicyChange(req, year, before, after, { startedFrom: from });
    return success(res, await policyView(year));
  } catch (err) {
    console.error('LeavePolicy.copy error:', err);
    return error(res, 'Failed to copy the leave policy', 500);
  }
};

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

/** GET /api/leave/types?all=1 */
const listTypes = async (req, res) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    return success(res, await leaveService.listTypes({ includeRetired: all }));
  } catch (err) {
    console.error('LeaveType.list error:', err);
    return error(res, 'Failed to load leave types', 500);
  }
};

/** POST /api/leave/types { name } — the key is made from the name, once. */
const createType = async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name.length < 2) return error(res, 'Give the leave type a name.', 400);
  try {
    const all = await LeaveType.findAll({ attributes: ['key', 'name', 'sortOrder'] });
    if (all.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      return error(res, `There is already a leave type called "${name}".`, 409, { code: 'TYPE_EXISTS' });
    }
    const key = rules.typeKeyFor(name, all.map((t) => t.key));
    if (!key) return error(res, 'The name must start with a letter.', 400);
    const sortOrder = Math.max(0, ...all.map((t) => t.sortOrder || 0)) + 1;
    const row = await LeaveType.create({ key, name, sortOrder, isSystem: false, status: 'active', createdBy: req.user.id, updatedBy: req.user.id });
    recordSettingChanges({
      user: req.user, area: AREA, before: { t: null }, after: { t: name },
      fields: { t: { key: `leave.type.${key}`, label: `Leave type "${name}"` } },
    });
    return success(res, { id: row.id, key: row.key, name: row.name, isSystem: false, status: row.status }, 201);
  } catch (err) {
    console.error('LeaveType.create error:', err);
    return error(res, 'Failed to add the leave type', 500);
  }
};

/** PATCH /api/leave/types/:id { name?, status? } — system types are never retired. */
const updateType = async (req, res) => {
  try {
    const row = await LeaveType.findByPk(req.params.id);
    if (!row) return error(res, 'Leave type not found', 404);
    const changes = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 80);
      if (name.length < 2) return error(res, 'Give the leave type a name.', 400);
      const others = await LeaveType.findAll({ where: { id: { [Op.ne]: row.id } }, attributes: ['name'] });
      const clash = others.some((t) => t.name.toLowerCase() === name.toLowerCase());
      if (clash) return error(res, `There is already a leave type called "${name}".`, 409, { code: 'TYPE_EXISTS' });
      changes.name = name;
    }
    if (req.body.status !== undefined) {
      if (!['active', 'retired'].includes(req.body.status)) return error(res, 'Status must be active or retired.', 400);
      if (row.isSystem && req.body.status === 'retired') {
        return error(res, `${row.name} is one of the clinic's original leave types and cannot be retired — switch it off in the policy instead.`, 409, { code: 'SYSTEM_TYPE' });
      }
      changes.status = req.body.status;
    }
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);
    const before = { name: row.name, status: row.status };
    await row.update({ ...changes, updatedBy: req.user.id });
    recordSettingChanges({
      user: req.user, area: AREA, before, after: { name: row.name, status: row.status },
      fields: {
        name: { key: `leave.type.${row.key}.name`, label: `Leave type ${row.key} · name` },
        status: { key: `leave.type.${row.key}.status`, label: `Leave type ${row.key} · status` },
      },
    });
    return success(res, { id: row.id, key: row.key, name: row.name, isSystem: !!row.isSystem, status: row.status });
  } catch (err) {
    console.error('LeaveType.update error:', err);
    return error(res, 'Failed to update the leave type', 500);
  }
};

// ---------------------------------------------------------------------------
// Public holidays (D4)
// ---------------------------------------------------------------------------

const holidayOut = (h) => ({
  id: h.id, date: String(h.date).slice(0, 10), name: h.name, status: h.status, source: h.source,
});

/** GET /api/leave/holidays?year=&all=1 — active (and with all=1, retired) holidays. */
const listHolidays = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || Number(clinicToday().slice(0, 4));
    const where = { date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } };
    if (!(req.query.all === '1' || req.query.all === 'true')) where.status = 'active';
    const rows = await PublicHoliday.findAll({ where, order: [['date', 'ASC']] });
    return success(res, { year, holidays: rows.map(holidayOut) });
  } catch (err) {
    console.error('PublicHoliday.list error:', err);
    return error(res, 'Failed to load public holidays', 500);
  }
};

const validDate = (s) => {
  if (!ISO_DATE.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * POST /api/leave/holidays { date, name } — adds a holiday, or brings back a
 * retired one on that date (one row per date).
 */
const createHoliday = async (req, res) => {
  const date = String(req.body.date || '').trim();
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!validDate(date)) return error(res, 'Choose the date of the holiday.', 400);
  if (name.length < 2) return error(res, 'Give the holiday a name.', 400);
  try {
    const existing = await PublicHoliday.findOne({ where: { date } });
    if (existing && existing.status === 'active') {
      return error(res, `${date} is already a public holiday (${existing.name}).`, 409, { code: 'HOLIDAY_EXISTS' });
    }
    let row;
    if (existing) {
      await existing.update({ name, status: 'active', updatedBy: req.user.id });
      row = existing;
    } else {
      row = await PublicHoliday.create({ date, name, status: 'active', source: 'hr', createdBy: req.user.id, updatedBy: req.user.id });
    }
    leaveService.clearHolidayCache();
    recordSettingChanges({
      user: req.user, area: AREA, before: { h: existing ? `${existing.name} (retired)` : null }, after: { h: name },
      fields: { h: { key: `leave.holiday.${date}`, label: `Public holiday ${date}` } },
    });
    return success(res, holidayOut(row), existing ? 200 : 201);
  } catch (err) {
    console.error('PublicHoliday.create error:', err);
    return error(res, 'Failed to add the public holiday', 500);
  }
};

/** PATCH /api/leave/holidays/:id { name?, status? } — rename, retire or bring back. */
const updateHoliday = async (req, res) => {
  try {
    const row = await PublicHoliday.findByPk(req.params.id);
    if (!row) return error(res, 'Public holiday not found', 404);
    const changes = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 120);
      if (name.length < 2) return error(res, 'Give the holiday a name.', 400);
      changes.name = name;
    }
    if (req.body.status !== undefined) {
      if (!['active', 'retired'].includes(req.body.status)) return error(res, 'Status must be active or retired.', 400);
      changes.status = req.body.status;
    }
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);
    const date = String(row.date).slice(0, 10);
    const before = { h: row.status === 'active' ? row.name : `${row.name} (retired)` };
    await row.update({ ...changes, updatedBy: req.user.id });
    leaveService.clearHolidayCache();
    recordSettingChanges({
      user: req.user, area: AREA, before, after: { h: row.status === 'active' ? row.name : `${row.name} (retired)` },
      fields: { h: { key: `leave.holiday.${date}`, label: `Public holiday ${date}` } },
    });
    return success(res, holidayOut(row));
  } catch (err) {
    console.error('PublicHoliday.update error:', err);
    return error(res, 'Failed to update the public holiday', 500);
  }
};

// ---------------------------------------------------------------------------
// Entitlements (D1, D3)
// ---------------------------------------------------------------------------

/** One person's row on the grid. */
const personRow = async ({ user, startDate = null, endDate = null }, year, asOf, policy) => {
  const picture = await leaveService.summaryFor(user.id, year, asOf, { policy });
  const overrides = await LeaveBalance.findAll({ where: { UserId: user.id, year } });
  const byType = Object.fromEntries(overrides.map((b) => [b.leaveType, b]));
  const week = overrides.map((b) => parseJsonColumn(b.weekOverride)).find(Boolean) || null;
  const cells = {};
  for (const s of picture.summary) {
    const o = byType[s.leaveType];
    cells[s.leaveType] = {
      entitled: s.entitled,
      unlimited: s.unlimited,
      source: s.source,
      proRated: s.proRated,
      carriedIn: s.carriedIn,
      taken: s.taken,
      booked: s.booked,
      remaining: s.remaining,
      override: o && (o.entitled !== null || o.carriedOver !== null)
        ? { entitled: num(o.entitled), carriedOver: num(o.carriedOver), reason: o.reason }
        : null,
    };
  }
  const reason = overrides.find((b) => b.reason)?.reason || null;
  return {
    ...personOf(user),
    startDate,
    endDate,
    weekOverride: week,
    reason,
    cells,
  };
};

/** Active staff for the grid: internal, active, not archived — with employment dates. */
const gridStaff = async () => {
  const users = (await internalUsers()).filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt);
  const profiles = await StaffProfile.findAll({ where: { UserId: users.map((u) => u.id) }, attributes: ['UserId', 'startDate', 'endDate'] });
  const byUser = new Map(profiles.map((p) => [p.UserId, p]));
  return users.map((u) => ({ user: u, startDate: byUser.get(u.id)?.startDate || null, endDate: byUser.get(u.id)?.endDate || null }));
};

/**
 * GET /api/leave/entitlements?year= — everyone's entitlement per type for the
 * year: from the policy (published, or the draft as a preview) with pro-rata,
 * or the person's override. Computed by leaveService.summaryFor — the same
 * numbers the staff file shows.
 */
const entitlements = async (req, res) => {
  try {
    const today = clinicToday();
    const year = parseInt(req.query.year, 10) || Number(today.slice(0, 4));
    const policy = await leaveService.loadPolicy(year, { publishedOnly: false });
    const asOf = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
    const staff = await gridStaff();
    const people = [];
    // A few at a time: each person is a handful of small queries.
    for (let i = 0; i < staff.length; i += 5) {
      people.push(...await Promise.all(staff.slice(i, i + 5).map((p) => personRow(p, year, asOf, policy))));
    }
    const types = (await leaveService.listTypes()).map((t) => ({
      key: t.key,
      name: t.name,
      days: policy?.types?.[t.key]?.days ?? null,
      grant: policy?.types?.[t.key]?.grant || null,
      enabled: !!policy?.types?.[t.key]?.enabled,
      carryCap: policy?.types?.[t.key]?.carryCap ?? 0,
    }));
    return success(res, {
      year,
      asOf,
      policyStatus: policy ? policy.status : 'none',
      proRate: !!policy?.proRate,
      weekWeights: policy?.weekWeights || null,
      types,
      people,
    });
  } catch (err) {
    console.error('LeaveEntitlement.grid error:', err);
    return error(res, 'Failed to load entitlements', 500);
  }
};

/**
 * PUT /api/leave/entitlements/:userId/:year
 * { balances: [{ leaveType, entitled, carriedOver }], weekOverride?, reason }
 * A reason is required — it is what HR will be asked about later.
 */
const saveEntitlement = async (req, res) => {
  const year = yearParam(req);
  if (!year) return error(res, 'Choose a year.', 400);
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  if (reason.length < 3) return error(res, 'Say why this person differs from the policy.', 400);
  try {
    const user = await User.findByPk(req.params.userId, {
      attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'],
      include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department', 'deletedAt', 'startDate', 'endDate'], required: false }],
    });
    if (!user || user.role === 'patient') return error(res, 'Staff member not found', 404);

    const balances = Array.isArray(req.body.balances) ? req.body.balances : [];
    const known = new Set((await leaveService.listTypes({ includeRetired: true })).map((t) => t.key));
    for (const b of balances) {
      if (!b || !known.has(b.leaveType)) return error(res, `Unknown leave type: ${b?.leaveType}`, 400);
      for (const f of ['entitled', 'carriedOver']) {
        const v = b[f];
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 366 || Math.round(n * 4) !== n * 4) {
          return error(res, `${b.leaveType}: ${f === 'entitled' ? 'days' : 'carried-in days'} must be between 0 and 366, in quarter days.`, 400);
        }
      }
    }
    let weekOverride;
    if (req.body.weekOverride !== undefined) {
      const w = rules.cleanWeek(req.body.weekOverride);
      if (!w.ok) return error(res, w.error, 400);
      weekOverride = w.value;
    }

    const { before, after } = await leaveService.saveOverrides({
      userId: user.id, year, balances, reason, actorId: req.user.id, weekOverride, policyMode: 'any',
    });

    // The log: one line per changed figure, on the Leave policy trail and on
    // the person's own Activity tab.
    const who = nameOf(user);
    const names = await typeNameMap();
    const key = (r) => r.leaveType;
    const b = Object.fromEntries(before.map((r) => [key(r), r]));
    const a = Object.fromEntries(after.map((r) => [key(r), r]));
    const flatB = {}, flatA = {}, fields = {}, changes = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
      for (const f of ['entitled', 'carriedOver']) {
        const from = b[k]?.[f] ?? null;
        const to = a[k]?.[f] ?? null;
        if (from === to) continue;
        const label = `${names[k] || k} · ${f === 'entitled' ? 'days' : 'carried in'}`;
        const field = `${k}.${f}`;
        flatB[field] = from === null ? 'policy' : from;
        flatA[field] = to === null ? `policy (${reason})` : `${to} (${reason})`;
        fields[field] = { key: `leave.entitlement.${year}.${user.id}.${field}`, label: `Entitlement ${year} · ${who} · ${label}` };
        changes[`leave ${year} ${label}`] = { from: from === null ? 'policy' : from, to: to === null ? 'policy' : to };
      }
    }
    const weekB = before.map((r) => r.weekOverride).find(Boolean) || null;
    const weekA = after.map((r) => r.weekOverride).find(Boolean) || null;
    if (showWeek(weekB) !== showWeek(weekA)) {
      flatB.week = showWeek(weekB);
      flatA.week = `${showWeek(weekA)} (${reason})`;
      fields.week = { key: `leave.entitlement.${year}.${user.id}.week`, label: `Entitlement ${year} · ${who} · own week` };
      changes[`leave ${year} own week`] = { from: showWeek(weekB), to: showWeek(weekA) };
    }
    if (Object.keys(changes).length) {
      recordSettingChanges({ user: req.user, area: AREA, before: flatB, after: flatA, fields });
      await writeUserEditLog({ targetUserId: user.id, actor: req.user, changes: { ...changes, reason: { from: null, to: reason } } });
    }

    const policy = await leaveService.loadPolicy(year, { publishedOnly: false });
    const today = clinicToday();
    const asOf = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
    return success(res, await personRow({
      user, startDate: user.StaffProfile?.startDate || null, endDate: user.StaffProfile?.endDate || null,
    }, year, asOf, policy));
  } catch (err) {
    console.error('LeaveEntitlement.save error:', err);
    return error(res, 'Failed to save the entitlement', 500);
  }
};

// ---------------------------------------------------------------------------
// Recent changes
// ---------------------------------------------------------------------------

/** GET /api/leave/changes — the last 50 lines of the Leave policy trail. */
const recentChanges = async (req, res) => {
  try {
    const rows = await SettingChangeLog.findAll({ where: { area: AREA }, order: [['changedAt', 'DESC'], ['id', 'DESC']], limit: 50 });
    return success(res, rows.map((r) => ({
      id: r.id, label: r.label, oldValue: r.oldValue, newValue: r.newValue, changedByName: r.changedByName, changedAt: r.changedAt,
    })));
  } catch (err) {
    console.error('LeavePolicy.changes error:', err);
    return error(res, 'Failed to load recent changes', 500);
  }
};

module.exports = {
  listPolicies,
  getPolicy,
  savePolicy,
  publishPolicy,
  copyPolicy,
  listTypes,
  createType,
  updateType,
  listHolidays,
  createHoliday,
  updateHoliday,
  entitlements,
  saveEntitlement,
  recentChanges,
  AREA,
};
