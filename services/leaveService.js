// Leave — the database side of the B27 leave rules.
//
// utils/leaveCalc, utils/leaveBalance and utils/leaveWorkflow hold the rules
// and are pure. This file loads what they need (types, the year's policy,
// holidays, someone's charges) and writes what they decide (charges, events),
// so every controller — the staff-file leave tab today, the application and
// approval wizards in phases 2–3 — asks the same questions the same way.
//
// Until a year's policy is PUBLISHED, leave for that year counts and reports
// exactly as it did before B27: entitlement from the staff-file row, weekends
// counted unless the "don't count weekends" box is ticked, no holidays. The
// draft policies seeded by migration 20260928000002 change nothing until HR
// publishes one.

const { Op } = require('sequelize');
const db = require('../models');
const sequelize = require('../config/database');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { countLeave, countLeaveDays, DEFAULT_WEEK_WEIGHTS } = require('../utils/leaveCalc');
const { summarise, carriedIn, entitlementFor } = require('../utils/leaveBalance');
const { TAKEN_STATUSES, BOOKED_STATUSES } = require('../utils/leaveWorkflow');
const { observedDayFor } = require('../utils/leaveCalc');
const { resolveExpected } = require('../utils/workHours');
const { getHrConfig } = require('../utils/hrConfig');

const {
  LeaveType, LeavePolicy, LeavePolicyType, PublicHoliday, LeaveBalance, LeaveCharge, LeaveEvent, StaffLeave, StaffProfile,
  StaffWorkHours,
} = db;

// The one leave type whose type and reason are health data (spec §11): shown
// only to the person, their approvers, and holders of leave.manage.
const PRIVATE_TYPES = new Set(['Sick']);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

/** Every leave type, active first by sortOrder. */
const listTypes = async ({ includeRetired = false } = {}) => {
  const where = includeRetired ? {} : { status: 'active' };
  const rows = await LeaveType.findAll({ where, order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  return rows.map((t) => ({ id: t.id, key: t.key, name: t.name, isSystem: !!t.isSystem, status: t.status }));
};

/** Is this an active leave type key? */
const isActiveType = async (key) => {
  if (typeof key !== 'string' || !key) return false;
  return !!(await LeaveType.findOne({ where: { key, status: 'active' }, attributes: ['id'] }));
};

/**
 * The year's policy as plain data, or null.
 * { id, year, status, weekWeights, countingMode, …, types: { [key]: {...} } }
 */
const loadPolicy = async (year, { publishedOnly = true } = {}) => {
  const where = { year };
  if (publishedOnly) where.status = 'published';
  const policy = await LeavePolicy.findOne({
    where,
    include: [{ model: LeavePolicyType, as: 'types', include: [{ model: LeaveType, as: 'type', attributes: ['key'] }] }],
  });
  if (!policy) return null;
  const types = {};
  for (const pt of policy.types || []) {
    if (!pt.type) continue;
    types[pt.type.key] = {
      days: num(pt.days),
      countedAs: pt.countedAs,
      grant: pt.grant,
      carryCap: num(pt.carryCap) ?? 0,
      halfDaysAllowed: !!pt.halfDaysAllowed,
      docRule: pt.docRule,
      docOverDays: num(pt.docOverDays),
      minNoticeDays: pt.minNoticeDays,
      proRate: !!pt.proRate,
      enabled: !!pt.enabled,
    };
  }
  return {
    id: policy.id,
    year: policy.year,
    status: policy.status,
    weekWeights: parseJsonColumn(policy.weekWeights) || DEFAULT_WEEK_WEIGHTS,
    countingMode: policy.countingMode,
    excludeHolidays: policy.excludeHolidays !== false,
    allowNegative: !!policy.allowNegative,
    proRate: !!policy.proRate,
    carryExpiry: policy.carryExpiry || null,
    minNoticeDays: policy.minNoticeDays || 0,
    maxCadreAwayPerDay: policy.maxCadreAwayPerDay,
    blockDoctorSlots: policy.blockDoctorSlots !== false,
    visibleTypes: parseJsonColumn(policy.visibleTypes),
    publishedAt: policy.publishedAt,
    types,
  };
};

// Holidays that count: active, and — when HR has switched off "a holiday on a
// Sunday is also observed" (HR Tier 2) — without the 'auto' observed days. The
// switch hides those rows; it never deletes them. ONE where-clause for every read.
const countingWhere = async (extra = {}) => {
  const cfg = await getHrConfig();
  const where = { status: 'active', ...extra };
  if (!cfg.observeSundayHolidays) where.source = { [Op.ne]: 'auto' };
  return where;
};

/** Active public holidays between two dates, as [{ date, name }]. */
const loadHolidays = async (from, to) => {
  const rows = await PublicHoliday.findAll({
    where: await countingWhere({ date: { [Op.between]: [from, to] } }),
    order: [['date', 'ASC']],
  });
  return rows.map((h) => ({ date: String(h.date).slice(0, 10), name: h.name }));
};

/**
 * Keep the observed days in step with the Sunday holidays (HR Tier 2). For
 * every active holiday on a Sunday with no observed day yet, add one ('auto',
 * pointing at it) on the next day that isn't already a holiday — unless any row
 * already holds that date (a retired one there is HR's decision; left alone).
 * An observed day whose Sunday holiday was retired is retired with it, and
 * comes back with it — but one HR retired themselves (updatedBy set) stays
 * retired. System writes leave updatedBy null. Idempotent; cheap (a few dozen
 * rows a year). Called on every holiday add/edit, on listing a year and when
 * the switch is turned on.
 * @returns {number} rows added or changed
 */
const syncObservedDays = async () => {
  const cfg = await getHrConfig();
  if (!cfg.observeSundayHolidays) return 0;
  const rows = await PublicHoliday.findAll();
  const byDate = new Map(rows.map((h) => [String(h.date).slice(0, 10), h]));
  const activeDates = new Set(rows.filter((h) => h.status === 'active').map((h) => String(h.date).slice(0, 10)));
  let changed = 0;
  for (const h of rows) {
    if (h.source === 'auto') continue;
    const day = String(h.date).slice(0, 10);
    const child = rows.find((x) => x.source === 'auto' && x.observedForId === h.id) || null;
    if (h.status !== 'active') {
      if (child && child.status === 'active') { await child.update({ status: 'retired', updatedBy: null }); changed += 1; }
      continue;
    }
    if (child) {
      if (child.status === 'retired' && child.updatedBy == null) { await child.update({ status: 'active' }); changed += 1; }
      continue;
    }
    const observed = observedDayFor(day, activeDates);
    if (!observed || byDate.has(observed)) continue;
    const row = await PublicHoliday.create({
      date: observed, name: `${h.name} (observed)`.slice(0, 120), status: 'active', source: 'auto', observedForId: h.id,
      createdBy: null, updatedBy: null,
    });
    byDate.set(observed, row);
    activeDates.add(observed);
    changed += 1;
  }
  if (changed) clearHolidayCache();
  return changed;
};

// Every active holiday as a Map date → name, cached briefly. Attendance asks
// for a day at a time (every tap, every person on the "today" board), and the
// list is a couple of dozen rows a year. HR's edits clear it at once.
const HOLIDAY_CACHE_MS = 60 * 1000;
let holidayCache = { map: null, at: 0 };
const clearHolidayCache = () => { holidayCache = { map: null, at: 0 }; };
const holidayMap = async () => {
  if (holidayCache.map && Date.now() - holidayCache.at < HOLIDAY_CACHE_MS) return holidayCache.map;
  const rows = await PublicHoliday.findAll({ where: await countingWhere(), attributes: ['date', 'name'] });
  const map = new Map(rows.map((h) => [String(h.date).slice(0, 10), h.name]));
  holidayCache = { map, at: Date.now() };
  return map;
};
/** The holiday's name on this clinic date, or null. */
const holidayOn = async (date) => (await holidayMap()).get(String(date).slice(0, 10)) || null;

/**
 * The person's own week for a year (D3), or null. Saved on each of their
 * override rows for the year (saveOverrides writes it to every type), so the
 * row for the type being charged is read first and any other row of the same
 * year is the fallback — e.g. a type HR added after the week was set.
 */
const personWeekFor = async (userId, year, leaveType) => {
  const rows = await LeaveBalance.findAll({ where: { UserId: userId, year }, attributes: ['leaveType', 'weekOverride'] });
  const own = rows.find((r) => r.leaveType === leaveType);
  const ownWeek = parseJsonColumn(own?.weekOverride);
  if (ownWeek) return ownWeek;
  for (const r of rows) {
    const w = parseJsonColumn(r.weekOverride);
    if (w) return w;
  }
  return null;
};

/**
 * Own-hours counting (policy countingMode 'own_hours', D3): is this person
 * expected in on a date, by their HR working hours (utils/workHours — dated
 * row, then weekly row, then the clinic default)? Holidays are left to
 * countLeave, which never counts them. When nothing at all is known for a date
 * — no row and no clinic default — the weekday value stands rather than
 * making every day free.
 *
 * @returns {Promise<(date: string) => boolean>}
 */
const expectedForPerson = async (userId) => {
  const [rows, cfg] = await Promise.all([
    StaffWorkHours.findAll({ where: { UserId: userId, status: 'active' } }).then((r) => r.map((x) => x.get({ plain: true }))),
    getHrConfig(),
  ]);
  return (date) => {
    const r = resolveExpected({ rows, clinicDate: date, defaults: cfg.hoursDefault, graceDefault: cfg.graceMinutes });
    if (r.source === null) return true;
    return !!r.startAt;
  };
};

/**
 * What a request costs.
 *
 * With a published policy for the start date's year: the weekday values, the
 * type's counting (working/calendar), holidays, part days, and — in order —
 * the person's own week if HR set one, else their own working hours when the
 * policy counts by own hours, else the clinic week. Without: the pre-B27
 * count (every day, or weekdays only when `excludeWeekends`), whole days only.
 *
 * breakdown.mode says which week was used: 'own_week' | 'own_hours' | 'clinic_week'.
 *
 * @returns {{ ok, error?, total, breakdown|null, returnDate|null, returnPart|null, policyYear|null, usedPolicy }}
 */
const costOf = async ({ userId, leaveType, start, end, startPart = 'full', endPart = 'full', excludeWeekends = false }) => {
  const year = Number(String(start).slice(0, 4));
  const policy = Number.isInteger(year) ? await loadPolicy(year) : null;

  if (!policy) {
    if (startPart !== 'full' || endPart !== 'full') {
      return { ok: false, error: 'HALF_DAYS_NEED_POLICY', total: 0 };
    }
    const total = countLeaveDays(start, end, { excludeWeekends: !!excludeWeekends });
    if (total <= 0) return { ok: false, error: 'END_BEFORE_START', total: 0 };
    return { ok: true, total, breakdown: null, returnDate: null, returnPart: null, policyYear: null, usedPolicy: false };
  }

  const pt = policy.types[leaveType] || { countedAs: 'working', halfDaysAllowed: true };
  if (!pt.halfDaysAllowed && (startPart !== 'full' || endPart !== 'full')) {
    return { ok: false, error: 'HALF_DAYS_NOT_ALLOWED', total: 0 };
  }

  const personWeek = userId ? await personWeekFor(userId, year, leaveType) : null;

  // Holidays for the range plus a little after, so the return date can skip one.
  const after = new Date(`${end}T00:00:00Z`);
  after.setUTCDate(after.getUTCDate() + 60);
  const holidays = policy.excludeHolidays ? await loadHolidays(start, after.toISOString().slice(0, 10)) : [];

  // A personal week wins; otherwise own-hours mode asks the person's HR hours
  // (phase 2), and clinic-week mode uses the policy's weekday values.
  const ownHours = !personWeek && policy.countingMode === 'own_hours' && userId;
  const expectedFor = ownHours ? await expectedForPerson(userId) : null;
  const mode = personWeek ? 'own_week' : (ownHours ? 'own_hours' : 'clinic_week');

  const r = countLeave({
    start, end, startPart, endPart, countedAs: pt.countedAs,
    weekWeights: policy.weekWeights, mode: ownHours ? 'own_hours' : 'clinic_week', personWeek, expectedFor, holidays,
  });
  if (!r.ok) return { ok: false, error: r.error, total: 0 };
  return {
    ok: true,
    total: r.total,
    breakdown: { groups: r.groups, holidays: r.holidaysInRange, countedAs: pt.countedAs, mode },
    returnDate: r.returnDate,
    returnPart: r.returnPart,
    policyYear: year,
    usedPolicy: true,
  };
};

/** A person's charges for a year, tagged taken / booked by the leave's status. */
const chargesFor = async (userId, year) => {
  const leaves = await StaffLeave.findAll({
    where: {
      UserId: userId,
      startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
      status: { [Op.in]: [...TAKEN_STATUSES, ...BOOKED_STATUSES] },
    },
    attributes: ['id', 'status', 'startDate'],
    include: [{ model: LeaveCharge, as: 'charges', where: { status: 'active' }, required: false }],
  });
  const out = [];
  for (const l of leaves) {
    const state = TAKEN_STATUSES.includes(l.status) ? 'taken' : 'booked';
    for (const c of l.charges || []) {
      out.push({ leaveType: c.leaveType, days: num(c.days), startDate: String(l.startDate).slice(0, 10), state });
    }
  }
  return out;
};

/**
 * The balance picture for one person and year (utils/leaveBalance summarise),
 * with carry-in from last year's published policy when there is one.
 */
const summaryFor = async (userId, year, asOf, { depth = 0, draft = false, policy: givenPolicy } = {}) => {
  // `draft` (phase 1): the entitlement grid previews a year HR has not
  // published yet with its draft policy. Everything else passes nothing and
  // gets the published policy only. `policy` lets a caller that loops over
  // every member of staff load the year's policy once.
  const [types, policy, overrideRows, charges, profile] = await Promise.all([
    listTypes({ includeRetired: true }),
    givenPolicy !== undefined ? givenPolicy : loadPolicy(year, { publishedOnly: !draft }),
    LeaveBalance.findAll({ where: { UserId: userId, year } }),
    chargesFor(userId, year),
    StaffProfile.findOne({ where: { UserId: userId }, attributes: ['startDate', 'endDate'] }),
  ]);

  const overrides = Object.fromEntries(overrideRows.map((b) => [b.leaveType, {
    entitled: num(b.entitled), carriedOver: num(b.carriedOver), reason: b.reason,
  }]));

  // Carry-in: last year's remaining, capped by this year's policy. Only when
  // both years are published — otherwise the pre-B27 carriedOver row stands.
  const carried = {};
  if (policy && depth < 3) {
    const prevPolicy = await loadPolicy(year - 1);
    if (prevPolicy) {
      const prev = await summaryFor(userId, year - 1, `${year - 1}-12-31`, { depth: depth + 1 });
      for (const row of prev.summary) {
        const cap = policy.types[row.leaveType]?.carryCap ?? 0;
        carried[row.leaveType] = carriedIn({ prevRemaining: row.remaining, carryCap: cap });
      }
    }
  }

  // Show active types, plus any retired type someone still has days against.
  const used = new Set([...charges.map((c) => c.leaveType), ...Object.keys(overrides)]);
  const shown = types.filter((t) => t.status === 'active' || used.has(t.key));
  // A key with no LeaveTypes row at all (shouldn't happen) still shows.
  for (const key of used) if (!shown.some((t) => t.key === key)) shown.push({ key, name: key });

  const summary = summarise({
    year,
    asOf,
    types: shown,
    policy: policy
      ? { carryExpiry: policy.carryExpiry, allowNegative: policy.allowNegative, visibleTypes: policy.visibleTypes }
      : {},
    policyTypes: policy ? policy.types : {},
    overrides,
    carried,
    charges,
    employment: { startDate: profile?.startDate || null, endDate: profile?.endDate || null },
  });

  return { year, policy, summary };
};

/**
 * Saves one person's entitlement overrides for a year (D1) — the one write
 * path, used by the staff file's leave tab and HR's entitlement grid.
 *
 * Per type: `entitled` / `carriedOver` — undefined leaves the stored value,
 * null or '' clears it (follow the policy). An `entitled` equal to what the
 * policy gives THIS person (after pro-rata) is stored as "follow the policy",
 * so a later policy change reaches them; comparing with the headline number
 * would freeze a joiner's pro-rated figure the first time anyone pressed Save.
 *
 * `weekOverride` (D3): undefined leaves it; null clears it; a clean week
 * (utils/leavePolicyRules cleanWeek) is written to the row of every active
 * type, so costOf finds it whatever the leave is charged to.
 *
 * `policyMode`: 'published' (the staff file — before a year is published the
 * old screen saves 0 for every type, which meant "nothing set" and is not
 * stored) or 'any' (the grid, which previews a draft year).
 *
 * @returns {Promise<{ before: object[], after: object[] }>}  plain rows
 */
const saveOverrides = async ({ userId, year, balances = [], reason, actorId, weekOverride, policyMode = 'published' }) => {
  const policy = await loadPolicy(year, { publishedOnly: policyMode === 'published' });
  const profile = policy
    ? await StaffProfile.findOne({ where: { UserId: userId }, attributes: ['startDate', 'endDate'] })
    : null;
  const followsPolicy = (key, value) => {
    const pt = policy?.types?.[key];
    if (!pt) return false;
    const e = entitlementFor({
      policyType: pt, year, proRate: !!pt.proRate,
      employment: { startDate: profile?.startDate || null, endDate: profile?.endDate || null },
    });
    return !e.unlimited && e.entitled !== null && Number(value) === e.entitled;
  };
  const toValue = (value, key, { checkPolicy }) => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (checkPolicy && followsPolicy(key, value)) return null;
    return Number(value);
  };
  const plainRow = (b) => ({
    leaveType: b.leaveType, year: b.year, entitled: num(b.entitled), carriedOver: num(b.carriedOver),
    reason: b.reason, weekOverride: parseJsonColumn(b.weekOverride),
  });

  const before = (await LeaveBalance.findAll({ where: { UserId: userId, year } })).map(plainRow);

  await sequelize.transaction(async (t) => {
    for (const entry of balances) {
      const entitled = toValue(entry.entitled, entry.leaveType, { checkPolicy: true });
      const carriedOver = toValue(entry.carriedOver, entry.leaveType, { checkPolicy: false });

      const row = await LeaveBalance.findOne({ where: { UserId: userId, year, leaveType: entry.leaveType }, transaction: t });
      if (!row) {
        const meaningless = (entitled == null || (policyMode === 'published' && !policy && entitled === 0))
          && (carriedOver == null || carriedOver === 0);
        if (meaningless) continue;
        await LeaveBalance.create({
          UserId: userId, year, leaveType: entry.leaveType,
          entitled: entitled ?? null, carriedOver: carriedOver ?? null,
          reason, createdBy: actorId,
        }, { transaction: t });
      } else {
        await row.update({
          entitled:    entitled === undefined ? row.entitled : entitled,
          carriedOver: carriedOver === undefined ? row.carriedOver : carriedOver,
          reason,
          updatedBy:   actorId,
        }, { transaction: t });
      }
    }

    if (weekOverride !== undefined) {
      const keys = (await LeaveType.findAll({ where: { status: 'active' }, attributes: ['key'], transaction: t })).map((x) => x.key);
      const existing = await LeaveBalance.findAll({ where: { UserId: userId, year }, transaction: t });
      const have = new Set(existing.map((r) => r.leaveType));
      for (const r of existing) {
        await r.update({ weekOverride, reason, updatedBy: actorId }, { transaction: t });
      }
      if (weekOverride !== null) {
        for (const key of keys.filter((k) => !have.has(k))) {
          await LeaveBalance.create({
            UserId: userId, year, leaveType: key, entitled: null, carriedOver: null,
            weekOverride, reason, createdBy: actorId,
          }, { transaction: t });
        }
      }
    }
  });

  const after = (await LeaveBalance.findAll({ where: { UserId: userId, year } })).map(plainRow);
  return { before, after };
};

/** Appends one entry to a request's timeline. Never updates or deletes. */
const recordEvent = (leaveId, actorId, type, { note = null, data = null } = {}, transaction) =>
  LeaveEvent.create({ leaveId, actorId: actorId || null, type, note, data }, { transaction });

/**
 * Replaces a leave's charge split: the old active rows become 'replaced'
 * (never deleted) and the new ones are written. Returns the previous split.
 */
const setCharges = async (leaveId, charges, actorId, transaction) => {
  const previous = await LeaveCharge.findAll({ where: { leaveId, status: 'active' }, transaction });
  if (previous.length) {
    await LeaveCharge.update({ status: 'replaced' }, { where: { leaveId, status: 'active' }, transaction });
  }
  for (const c of charges) {
    await LeaveCharge.create({
      leaveId, leaveType: c.leaveType, days: round2(Number(c.days)), setById: actorId || null, status: 'active',
    }, { transaction });
  }
  return previous.map((c) => ({ leaveType: c.leaveType, days: num(c.days) }));
};

/** Marks every active charge of a leave replaced — the leave no longer draws on any balance. */
const releaseCharges = (leaveId, transaction) =>
  LeaveCharge.update({ status: 'replaced' }, { where: { leaveId, status: 'active' }, transaction });

module.exports = {
  PRIVATE_TYPES,
  listTypes,
  isActiveType,
  loadPolicy,
  loadHolidays,
  syncObservedDays,
  holidayMap,
  holidayOn,
  clearHolidayCache,
  costOf,
  chargesFor,
  summaryFor,
  saveOverrides,
  personWeekFor,
  recordEvent,
  setCharges,
  releaseCharges,
};
