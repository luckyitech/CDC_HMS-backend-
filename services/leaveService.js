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
const { parseJsonColumn } = require('../utils/jsonColumn');
const { countLeave, countLeaveDays, DEFAULT_WEEK_WEIGHTS } = require('../utils/leaveCalc');
const { summarise, carriedIn } = require('../utils/leaveBalance');
const { TAKEN_STATUSES, BOOKED_STATUSES } = require('../utils/leaveWorkflow');

const {
  LeaveType, LeavePolicy, LeavePolicyType, PublicHoliday, LeaveBalance, LeaveCharge, LeaveEvent, StaffLeave, StaffProfile,
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

/** Active public holidays between two dates, as [{ date, name }]. */
const loadHolidays = async (from, to) => {
  const rows = await PublicHoliday.findAll({
    where: { status: 'active', date: { [Op.between]: [from, to] } },
    order: [['date', 'ASC']],
  });
  return rows.map((h) => ({ date: String(h.date).slice(0, 10), name: h.name }));
};

/**
 * What a request costs.
 *
 * With a published policy for the start date's year: the weekday values, the
 * type's counting (working/calendar), holidays, part days, and the person's
 * own week if HR set one. Without: the pre-B27 count (every day, or weekdays
 * only when `excludeWeekends`), whole days only.
 *
 * @returns {{ ok, error?, total, breakdown|null, returnDate|null, policyYear|null, usedPolicy }}
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
    return { ok: true, total, breakdown: null, returnDate: null, policyYear: null, usedPolicy: false };
  }

  const pt = policy.types[leaveType] || { countedAs: 'working', halfDaysAllowed: true };
  if (!pt.halfDaysAllowed && (startPart !== 'full' || endPart !== 'full')) {
    return { ok: false, error: 'HALF_DAYS_NOT_ALLOWED', total: 0 };
  }

  const override = userId
    ? await LeaveBalance.findOne({ where: { UserId: userId, year, leaveType }, attributes: ['weekOverride'] })
    : null;
  const personWeek = parseJsonColumn(override?.weekOverride);

  // Holidays for the range plus a little after, so the return date can skip one.
  const after = new Date(`${end}T00:00:00Z`);
  after.setUTCDate(after.getUTCDate() + 60);
  const holidays = policy.excludeHolidays ? await loadHolidays(start, after.toISOString().slice(0, 10)) : [];

  // Own-hours mode needs the person's working hours; that lookup arrives with
  // the application wizard (phase 2). Until then own_hours reads as the clinic
  // week — stated here so nobody assumes otherwise.
  const r = countLeave({
    start, end, startPart, endPart, countedAs: pt.countedAs,
    weekWeights: policy.weekWeights, mode: 'clinic_week', personWeek, holidays,
  });
  if (!r.ok) return { ok: false, error: r.error, total: 0 };
  return {
    ok: true,
    total: r.total,
    breakdown: { groups: r.groups, holidays: r.holidaysInRange, countedAs: pt.countedAs },
    returnDate: r.returnDate,
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
const summaryFor = async (userId, year, asOf, { depth = 0 } = {}) => {
  const [types, policy, overrideRows, charges, profile] = await Promise.all([
    listTypes({ includeRetired: true }),
    loadPolicy(year),
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
      ? { carryExpiry: policy.carryExpiry, proRate: policy.proRate, allowNegative: policy.allowNegative, visibleTypes: policy.visibleTypes }
      : {},
    policyTypes: policy ? policy.types : {},
    overrides,
    carried,
    charges,
    employment: { startDate: profile?.startDate || null, endDate: profile?.endDate || null },
  });

  return { year, policy, summary };
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
  costOf,
  chargesFor,
  summaryFor,
  recordEvent,
  setCharges,
  releaseCharges,
};
