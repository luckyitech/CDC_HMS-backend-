// A member of staff's OWN leave — B27 phase 2 (Apply). /api/hr/me/leave…
//
// Every action here acts on req.user.id's own requests: no route in
// routes/hrSelf.js names a person, and every lookup is
// `where: { id, UserId: req.user.id }` (tests/hrLeavePhase2.test.js). Deciding
// a colleague's request is phase 3 (routes/leave.js, leave.approve).
//
// evaluate() is the ONE place a request is judged. The wizard's preview
// returns it; the submit refuses on its errors. Checks, in order:
//   utils/leaveApply.applicationCheck (type offered? crosses 31 Dec? backdated?
//   short notice?) → leaveService.costOf (the day count, own hours included)
//   → own overlap (409 OVERLAP) → balance (blocks only under a PUBLISHED
//   policy that doesn't allow a negative balance: INSUFFICIENT_BALANCE)
//   → colleagues of the same role who are away (names and dates only).
//
// Sick leave is health data (spec §11): bell and email text never name a sick
// type, never carry a reason or an answer (services/hrNotify is told "Leave").

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { isIsoDate, rangesOverlap } = require('../utils/leaveCalc');
const { checkBalance } = require('../utils/leaveBalance');
const {
  STATUS, OPEN_STATUSES, TAKEN_STATUSES, KIND, DECISION, WorkflowError, validateParticipants, applyEvent,
} = require('../utils/leaveWorkflow');
const {
  applicationCheck, clashes, documentNeededFor, offeredKeys, noticeFor, describe,
} = require('../utils/leaveApply');
const { PERMISSIONS, passesAdminGate, INTERNAL_ROLES } = require('../constants/permissions');
const leaveService = require('../services/leaveService');
const hrNotify = require('../services/hrNotify');
const db = require('../models');
const sequelize = require('../config/database');

const { StaffLeave, LeaveParticipant, LeaveEvent, StaffDocument, StaffProfile, User } = db;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);
const clip = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// How many days ahead "Coming up" looks.
const UPCOMING_DAYS = 120;

// Where the bell and the email send an approver. The approvals inbox is phase 3.
const approverLink = (id) => `/hr/leave?id=${id}`;
const applicantLink = (id) => `/hr/me/leave?open=${id}`;

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 'Mon 7 Dec' — for notification text only. */
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const rangeText = (s, e) => (s === e ? shortDate(s) : `${shortDate(s)} – ${shortDate(e)}`);
const daysText = (n) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;

/** What a notification may call this leave: never the type when it is private. */
const typeForNotice = (key, typeNames) => (leaveService.PRIVATE_TYPES.has(key)
  ? 'Leave'
  : `${typeNames[key] || key} leave`);

const HTTP = {
  OVERLAP: 409, INSUFFICIENT_BALANCE: 409,
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const detailIncludes = () => [
  { model: LeaveParticipant, as: 'participants', include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role'] }] },
  { model: LeaveEvent, as: 'events', include: [{ model: User, as: 'actor', attributes: ['id', 'firstName', 'lastName'] }] },
  { association: 'charges', required: false },
  { model: StaffDocument, as: 'attachment', attributes: ['id', 'documentId', 'fileName', 'category', 'isArchived'], required: false },
];

/**
 * One request for the screen. Exported for phase 3 (the approval panel shows
 * the same shape to approvers).
 *
 * @param {object} leave     StaffLeave with detailIncludes()
 * @param {object} opts
 * @param {object} [opts.typeNames]  key → name
 * @param {boolean} [opts.redact]    a viewer who may not see a private type's
 *                                   type and reason (phase 3; never the applicant)
 * @param {string} [opts.today]
 */
const formatApplication = (leave, { typeNames = {}, redact = false, today = clinicToday() } = {}) => {
  const hide = redact && leaveService.PRIVATE_TYPES.has(leave.leaveType);
  const snap = parseJsonColumn(leave.breakdown) || {};
  const participants = (leave.participants || [])
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || (a.id - b.id))
    .map((p) => ({
      userId: p.UserId,
      name: fullName(p.User) || 'Former colleague',
      role: p.User?.role || null,
      kind: p.kind,
      decision: p.decision,
      decidedAt: p.decidedAt,
      note: redact ? null : p.note,
    }));
  const events = (leave.events || [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id - b.id)
    .map((e) => ({
      id: e.id,
      type: e.type,
      actorId: e.actorId,
      actorName: fullName(e.actor) || null,
      note: redact ? null : e.note,
      data: redact ? null : parseJsonColumn(e.data),
      createdAt: e.createdAt,
    }));
  const charges = (leave.charges || []).filter((c) => c.status === 'active')
    .map((c) => ({ leaveType: hide && leaveService.PRIVATE_TYPES.has(c.leaveType) ? 'Private' : c.leaveType, days: num(c.days) }));

  const startDate = String(leave.startDate).slice(0, 10);
  const endDate = String(leave.endDate).slice(0, 10);
  const documentNeeded = !!snap.documentNeeded;
  const attachment = leave.attachment && !leave.attachment.isArchived
    ? { id: leave.attachment.id, documentId: leave.attachment.documentId, fileName: leave.attachment.fileName, category: leave.attachment.category }
    : null;
  const started = startDate <= today;
  // The latest question an approver asked, while it is still open.
  const openQuestion = leave.status === STATUS.INFO_REQUESTED
    ? [...events].reverse().find((e) => e.type === 'info_requested') || null
    : null;

  return {
    id: leave.id,
    leaveType: hide ? 'Private' : leave.leaveType,
    typeName: hide ? 'Private' : (typeNames[leave.leaveType] || leave.leaveType),
    startDate,
    endDate,
    startPart: leave.startPart || 'full',
    endPart: leave.endPart || 'full',
    days: num(leave.days),
    returnDate: leave.returnDate ? String(leave.returnDate).slice(0, 10) : null,
    reason: hide ? null : leave.reason,
    status: leave.status,
    submittedAt: leave.submittedAt || leave.createdAt,
    reachable: leave.reachable,
    contactNote: hide ? null : leave.contactNote,
    decisionNote: redact ? null : leave.decisionNote,
    approvedAt: leave.approvedAt,
    onBehalf: !!leave.onBehalf,
    policyYear: leave.policyYear,
    breakdown: hide ? null : {
      groups: snap.groups || null,
      holidays: snap.holidays || [],
      countedAs: snap.countedAs || null,
      mode: snap.mode || null,
      usedPolicy: snap.usedPolicy !== undefined ? !!snap.usedPolicy : !!snap.groups,
    },
    flags: {
      backdated: !!snap.backdated,
      shortNotice: !!snap.shortNotice,
      documentNeeded,
      documentOwed: documentNeeded && !attachment,
    },
    clashNames: hide ? [] : (snap.clashNames || []),
    attachment: hide ? null : attachment,
    participants,
    events,
    charges,
    openQuestion: openQuestion ? { note: openQuestion.note, by: openQuestion.actorName, at: openQuestion.createdAt } : null,
    can: {
      withdraw: OPEN_STATUSES.includes(leave.status),
      reply: leave.status === STATUS.INFO_REQUESTED,
      cancelRequest: leave.status === STATUS.APPROVED && !started,
      addDocument: documentNeeded && !attachment
        && ![STATUS.WITHDRAWN, STATUS.CANCELLED, STATUS.REJECTED].includes(leave.status),
    },
  };
};

const typeNameMap = async () => Object.fromEntries(
  (await leaveService.listTypes({ includeRetired: true })).map((t) => [t.key, t.name])
);

// ---------------------------------------------------------------------------
// The judgement — one function for preview and submit
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<object>} {
 *   ok, errors:[{code,message}], warnings:[{code,message}], status (HTTP for the first error),
 *   leaveType, startDate, endDate, startPart, endPart, total, breakdown, returnDate, returnPart,
 *   policyYear, usedPolicy, documentNeeded, balance, clashes, notice }
 */
const evaluate = async ({ user, body, today, asHr = false }) => {
  const leaveType = typeof body.leaveType === 'string' ? body.leaveType.trim() : '';
  const startDate = String(body.startDate || '').slice(0, 10);
  const endDate = String(body.endDate || '').slice(0, 10);
  const startPart = body.startPart || 'full';
  const endPart = body.endPart || 'full';

  const out = {
    ok: false, errors: [], warnings: [], status: 400,
    leaveType, startDate, endDate, startPart, endPart,
    total: 0, breakdown: null, returnDate: null, returnPart: null,
    policyYear: null, usedPolicy: false, documentNeeded: false,
    balance: null, clashes: { people: [], overLimit: [] }, notice: { asked: 0, given: null },
  };
  const fail = (code, status = HTTP[code] || 400) => {
    // HR recording for someone reads about them, not about "you".
    const d = describe(code);
    if (asHr && code === 'OVERLAP') d.message = 'They already have leave on some of these days.';
    out.errors.push(d);
    if (out.errors.length === 1) out.status = status;
  };

  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    fail('BAD_DATE');
    return out;
  }

  const year = Number(startDate.slice(0, 4));
  const [types, policy] = await Promise.all([leaveService.listTypes(), leaveService.loadPolicy(year)]);

  const check = applicationCheck({ leaveType, start: startDate, end: endDate, today, types, policy });
  // HR recording on someone's behalf (phase 3) may use a type staff can't see
  // (D10: hidden types still exist; HR records and charges to them), and
  // notice is the applicant's concern, not HR's.
  const skip = asHr ? new Set(['TYPE_NOT_OFFERED', 'SHORT_NOTICE']) : new Set();
  check.errors.filter((c) => !skip.has(c)).forEach((c) => fail(c));
  check.warnings.filter((c) => !skip.has(c)).forEach((c) => out.warnings.push(describe(c)));
  out.notice = { asked: check.notice, given: check.noticeGiven };
  if (out.errors.length) return out;

  const cost = await leaveService.costOf({
    userId: user.id, leaveType, start: startDate, end: endDate, startPart, endPart,
    // Before a year's policy is published the old count applies: every day,
    // or weekdays only when the applicant ticks "don't count weekends".
    excludeWeekends: !policy && !!body.excludeWeekends,
  });
  if (!cost.ok) {
    fail(cost.error);
    return out;
  }
  out.total = cost.total;
  out.breakdown = cost.breakdown;
  out.returnDate = cost.returnDate;
  out.returnPart = cost.returnPart || null;
  out.policyYear = cost.policyYear || year;
  out.usedPolicy = cost.usedPolicy;
  if (cost.total <= 0) {
    fail('ZERO_DAYS');
    return out;
  }

  out.documentNeeded = documentNeededFor(policy, leaveType, cost.total);
  if (out.documentNeeded) out.warnings.push(describe('DOCUMENT_NEEDED'));

  // Own overlap — two live requests on one day would double-count.
  const mine = await StaffLeave.findAll({
    where: {
      UserId: user.id,
      status: { [Op.in]: [...OPEN_STATUSES, ...TAKEN_STATUSES] },
      startDate: { [Op.lte]: endDate },
      endDate: { [Op.gte]: startDate },
    },
    attributes: ['id', 'startDate', 'endDate', 'status'],
  });
  const overlap = mine.find((l) => rangesOverlap(startDate, endDate, l.startDate, l.endDate));
  if (overlap) {
    fail('OVERLAP');
    out.overlap = { id: overlap.id, startDate: String(overlap.startDate).slice(0, 10), endDate: String(overlap.endDate).slice(0, 10), status: overlap.status };
  }

  // Balance. Shown always; blocks only under a published policy without negatives.
  const picture = await leaveService.summaryFor(user.id, year, today, { policy });
  const row = picture.summary.find((s) => s.leaveType === leaveType) || null;
  if (row) {
    out.balance = {
      leaveType,
      unlimited: !!row.unlimited,
      left: row.remaining,
      booked: row.booked,
      leftAfterBooked: row.remainingAfterBooked,
      after: row.unlimited || row.remainingAfterBooked === null ? null : Math.round((row.remainingAfterBooked - cost.total) * 100) / 100,
    };
    if (policy) {
      const bal = checkBalance({ summary: picture.summary, charges: [{ leaveType, days: cost.total }], allowNegative: policy.allowNegative });
      if (!bal.ok) {
        out.balance.short = bal.short[leaveType];
        // HR recording on someone's behalf is told, not stopped: they are the
        // people who decide what the balance should be.
        if (asHr) out.warnings.push(describe('OVER_BALANCE'));
        else fail('INSUFFICIENT_BALANCE');
      }
    }
  }

  // Same-role colleagues who are away — names and dates only.
  const others = await StaffLeave.findAll({
    where: {
      UserId: { [Op.ne]: user.id },
      status: { [Op.in]: [...OPEN_STATUSES, ...TAKEN_STATUSES] },
      startDate: { [Op.lte]: endDate },
      endDate: { [Op.gte]: startDate },
    },
    attributes: ['UserId', 'startDate', 'endDate'],
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role'], where: { role: user.role, isActive: true } }],
  });
  const holidays = new Set((await leaveService.loadHolidays(startDate, endDate)).map((h) => h.date));
  out.clashes = clashes({
    start: startDate,
    end: endDate,
    others: others.map((o) => ({ userId: o.UserId, name: fullName(o.User), startDate: o.startDate, endDate: o.endDate })),
    maxPerDay: policy ? policy.maxCadreAwayPerDay : null,
    skipDates: holidays,
  });
  if (out.clashes.people.length) out.warnings.push(describe('CLASH'));
  if (out.clashes.overLimit.length) out.warnings.push(describe('OVER_LIMIT'));

  out.ok = out.errors.length === 0;
  if (out.ok) out.status = 200;
  return out;
};

/** The applicant's own record: role and names come from the DB, never the client. */
const loadMe = (id) => User.findByPk(id, {
  attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'],
  include: [{ model: StaffProfile, attributes: ['employeeId', 'reportsToId', 'deletedAt'], required: false }],
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * A person's leave for a year: balances, the types they can apply for, their
 * applications, and what is coming up (their own leave + public holidays,
 * 120 days). One builder for My leave (/api/hr/me/leave) and the staff file's
 * Leave tab (GET /api/staff/:employeeId/leaves, phase 3), so both show the
 * same numbers.
 *
 * `redact` — a viewer who may see the file but not private leave (users.view
 * without leave.manage): private types become "Private", no reasons, and the
 * private balances are left out (health data, spec §11).
 */
const buildOverview = async ({ userId, year, today = clinicToday(), redact = false }) => {
  const user = await loadMe(userId);
  if (!user) return null;

  const [types, policy, typeNames] = await Promise.all([
    leaveService.listTypes(), leaveService.loadPolicy(year), typeNameMap(),
  ]);
  const picture = await leaveService.summaryFor(user.id, year, year === Number(today.slice(0, 4)) ? today : `${year}-12-31`, { policy });
  const offered = new Set(offeredKeys(types, policy));
  const hidden = (key) => redact && leaveService.PRIVATE_TYPES.has(key);

  const balances = picture.summary
    .filter((s) => offered.has(s.leaveType) || s.taken > 0 || s.booked > 0)
    .filter((s) => !hidden(s.leaveType))
    .map((s) => ({
      leaveType: s.leaveType,
      name: s.name,
      unlimited: s.unlimited,
      entitled: s.entitled,
      source: s.source,
      carriedIn: s.carriedIn,
      carriedLeft: s.carriedLeft,
      carryExpires: s.carryExpires,
      taken: s.taken,
      booked: s.booked,
      remaining: s.remaining,
      remainingAfterBooked: s.remainingAfterBooked,
      proRated: s.proRated,
      offered: offered.has(s.leaveType),
    }));

  const offeredTypes = types.filter((t) => offered.has(t.key)).map((t) => {
    const pt = policy?.types?.[t.key] || null;
    const bal = balances.find((b) => b.leaveType === t.key);
    return {
      key: t.key,
      name: t.name,
      remaining: bal ? bal.remainingAfterBooked : null,
      unlimited: bal ? bal.unlimited : true,
      halfDaysAllowed: policy ? !!pt?.halfDaysAllowed : false,
      countedAs: pt?.countedAs || 'working',
      docRule: pt?.docRule || 'never',
      docOverDays: pt?.docOverDays ?? null,
      notice: noticeFor(policy, t.key),
    };
  });

  const leaves = await StaffLeave.findAll({
    where: {
      UserId: user.id,
      [Op.or]: [
        { startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
        // Anything still live that is not over yet, whatever year it starts in.
        { status: { [Op.in]: [...OPEN_STATUSES, ...TAKEN_STATUSES] }, endDate: { [Op.gte]: today } },
      ],
    },
    include: detailIncludes(),
    order: [['startDate', 'DESC']],
  });
  const applications = leaves.map((l) => formatApplication(l, { typeNames, today, redact }));

  const horizon = addDays(today, UPCOMING_DAYS);
  const holidays = await leaveService.loadHolidays(today, horizon);
  const upcoming = [
    ...applications
      .filter((a) => [...OPEN_STATUSES, ...TAKEN_STATUSES].includes(a.status) && a.endDate >= today && a.startDate <= horizon)
      .map((a) => ({ kind: 'leave', id: a.id, date: a.startDate, endDate: a.endDate, label: a.leaveType === 'Private' ? 'Leave' : `${a.typeName} leave`, status: a.status })),
    ...holidays.map((h) => ({ kind: 'holiday', date: h.date, endDate: h.date, label: h.name })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return {
    year,
    today,
    userId: user.id,
    name: fullName(user),
    employeeId: user.StaffProfile && !user.StaffProfile.deletedAt ? user.StaffProfile.employeeId : null,
    policyPublished: !!policy,
    policy: policy ? {
      countingMode: policy.countingMode,
      allowNegative: policy.allowNegative,
      minNoticeDays: policy.minNoticeDays,
      carryExpiry: policy.carryExpiry,
    } : null,
    balances,
    types: offeredTypes,
    applications,
    upcoming,
  };
};

/** GET /api/hr/me/leave?year= — my own leave (buildOverview). */
const overview = async (req, res) => {
  try {
    const today = clinicToday();
    const year = parseInt(req.query.year, 10) || Number(today.slice(0, 4));
    const data = await buildOverview({ userId: req.user.id, year, today });
    if (!data) return error(res, 'Account not found', 404);
    return success(res, data);
  } catch (err) {
    console.error('SelfLeave.overview error:', err);
    return error(res, 'Failed to load your leave', 500);
  }
};

/**
 * POST /api/hr/me/leave/preview — the calculator. Writes nothing. Always 200
 * with the judgement (ok, errors, warnings) so the wizard can show it.
 */
const preview = async (req, res) => {
  try {
    const me = await loadMe(req.user.id);
    if (!me) return error(res, 'Account not found', 404);
    const result = await evaluate({ user: me, body: req.body || {}, today: clinicToday() });
    return success(res, result);
  } catch (err) {
    console.error('SelfLeave.preview error:', err);
    return error(res, 'Failed to work out those dates', 500);
  }
};

const PARTICIPANT_MESSAGES = {
  NO_APPROVER: 'Add at least one approver.',
  NO_APPROVE_HOLDER: 'At least one approver must be someone who can approve leave.',
  SELF: 'You cannot list yourself.',
  DUPLICATE: 'Each person can be listed once.',
  INACTIVE: 'One of the people you chose is no longer active.',
  BAD_USER: 'One of the people you chose could not be found.',
  BAD_KIND: 'Choose approver or acknowledger for each person.',
};

/** Active internal colleagues among these ids, with what the gate needs. */
const loadColleagues = async (ids) => {
  if (!ids.length) return [];
  const users = await User.findAll({
    where: { id: { [Op.in]: ids }, isActive: true, role: { [Op.in]: INTERNAL_ROLES } },
    attributes: ['id', 'firstName', 'lastName', 'role', 'permissions', 'deniedPermissions', 'staffType', 'email'],
    include: [{ model: StaffProfile, attributes: ['deletedAt'], required: false }],
  });
  return users.filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt);
};

/**
 * POST /api/hr/me/leave — submit.
 * { leaveType, startDate, endDate, startPart, endPart, excludeWeekends,
 *   participants: [{ userId, kind }], reason, reachable, contactNote, attachmentDocumentId }
 */
const submit = async (req, res) => {
  try {
    const today = clinicToday();
    const me = await loadMe(req.user.id);
    if (!me) return error(res, 'Account not found', 404);
    const body = req.body || {};

    const result = await evaluate({ user: me, body, today });
    if (!result.ok) {
      const first = result.errors[0];
      return error(res, first.message, result.status, { code: first.code, errors: result.errors, balance: result.balance, overlap: result.overlap });
    }

    // The people.
    const list = Array.isArray(body.participants) ? body.participants.map((p) => ({ userId: Number(p?.userId), kind: p?.kind })) : [];
    const colleagues = await loadColleagues([...new Set(list.map((p) => p.userId).filter((n) => Number.isInteger(n) && n > 0))]);
    const activeUsers = new Set(colleagues.map((u) => u.id));
    const approveHolders = new Set(colleagues.filter((u) => passesAdminGate(u, PERMISSIONS.LEAVE_APPROVE)).map((u) => u.id));
    const people = validateParticipants(list, me.id, { approveHolders, activeUsers });
    if (!people.ok) {
      const code = people.errors[0];
      return error(res, PARTICIPANT_MESSAGES[code] || 'Check the people you chose.', 400, { code, errors: people.errors });
    }

    // A document offered now must be the applicant's own, live one.
    let attachmentId = null;
    if (body.attachmentDocumentId !== undefined && body.attachmentDocumentId !== null && body.attachmentDocumentId !== '') {
      const doc = await StaffDocument.findOne({ where: { id: Number(body.attachmentDocumentId), UserId: me.id, isArchived: false } });
      if (!doc) return error(res, 'That document is not one of yours.', 400, { code: 'BAD_DOCUMENT' });
      attachmentId = doc.id;
    }

    const flags = {
      backdated: result.warnings.some((w) => w.code === 'BACKDATED'),
      shortNotice: result.warnings.some((w) => w.code === 'SHORT_NOTICE'),
      documentNeeded: result.documentNeeded,
    };
    const clashNames = [...new Set(result.clashes.people.map((p) => p.name))];
    const now = new Date();

    const leave = await sequelize.transaction(async (t) => {
      const row = await StaffLeave.create({
        UserId: me.id,
        leaveType: result.leaveType,
        startDate: result.startDate,
        endDate: result.endDate,
        startPart: result.startPart,
        endPart: result.endPart,
        days: result.total,
        reason: clip(body.reason, 2000),
        status: STATUS.PENDING,
        submittedAt: now,
        policyYear: result.policyYear,
        returnDate: result.returnDate,
        reachable: typeof body.reachable === 'boolean' ? body.reachable : null,
        contactNote: clip(body.contactNote, 255),
        // The calculator's answer as it stood — display only, never recomputed.
        breakdown: { ...(result.breakdown || {}), usedPolicy: result.usedPolicy, ...flags, clashNames },
        attachmentDocumentId: attachmentId,
        onBehalf: false,
        createdBy: me.id,
      }, { transaction: t });

      await LeaveParticipant.bulkCreate(list.map((p, i) => ({
        leaveId: row.id,
        UserId: p.userId,
        kind: p.kind,
        decision: p.kind === KIND.APPROVER ? DECISION.PENDING : DECISION.NOTIFIED,
        sortOrder: i,
      })), { transaction: t });

      await leaveService.setCharges(row.id, [{ leaveType: result.leaveType, days: result.total }], me.id, t);
      await leaveService.recordEvent(row.id, me.id, 'submitted', {
        data: { days: result.total, leaveType: result.leaveType, ...flags },
      }, t);
      return row;
    });

    // Tell the people — best-effort; never fails the request.
    const typeNames = await typeNameMap();
    const what = `${typeForNotice(result.leaveType, typeNames)}: ${rangeText(result.startDate, result.endDate)} · ${daysText(result.total)}`;
    const approvers = list.filter((p) => p.kind === KIND.APPROVER).map((p) => p.userId);
    const acknowledgers = list.filter((p) => p.kind === KIND.ACKNOWLEDGER).map((p) => p.userId);
    await hrNotify.notify('leave_to_approve', {
      recipients: approvers,
      title: `Leave request from ${fullName(me)} — action needed`,
      body: `${what}.\nOpen the HMS to approve, decline or ask a question.`,
      link: approverLink(leave.id),
      actorName: fullName(me),
    });
    await hrNotify.notify('leave_acknowledge', {
      recipients: acknowledgers,
      title: `${fullName(me)} has applied for leave — for your information`,
      body: `${what}.\nYou are listed to be told; you don't need to approve it.`,
      link: approverLink(leave.id),
      actorName: fullName(me),
    });

    await leave.reload({ include: detailIncludes() });
    return success(res, formatApplication(leave, { typeNames, today }), 201);
  } catch (err) {
    console.error('SelfLeave.submit error:', err);
    return error(res, 'Failed to submit your request', 500);
  }
};

/** Loads one of MY requests with detail, or null. */
const findMine = (req) => StaffLeave.findOne({ where: { id: Number(req.params.id), UserId: req.user.id }, include: detailIncludes() });

/** GET /api/hr/me/leave/:id */
const getOne = async (req, res) => {
  try {
    const leave = await findMine(req);
    if (!leave) return error(res, 'Leave request not found', 404);
    return success(res, formatApplication(leave, { typeNames: await typeNameMap() }));
  } catch (err) {
    console.error('SelfLeave.getOne error:', err);
    return error(res, 'Failed to load the request', 500);
  }
};

/**
 * Applies a workflow event to one of MY requests: updates the status and any
 * participant whose decision changed, writes the timeline entry, and runs
 * `after` inside the same transaction.
 */
const transition = async (leave, me, eventType, { timelineType, note = null, after } = {}) => {
  const participants = leave.participants.map((p) => ({ id: p.id, userId: p.UserId, kind: p.kind, decision: p.decision }));
  const result = applyEvent({
    status: leave.status,
    participants,
    event: { type: eventType, actorId: me.id, isApplicant: true, started: String(leave.startDate).slice(0, 10) <= clinicToday() },
  });
  await sequelize.transaction(async (t) => {
    await leave.update({ status: result.status, updatedBy: me.id }, { transaction: t });
    for (const p of result.participants) {
      const before = participants.find((x) => x.id === p.id);
      if (before && before.decision !== p.decision) {
        await LeaveParticipant.update({ decision: p.decision, decidedAt: null, note: null }, { where: { id: p.id }, transaction: t });
      }
    }
    await leaveService.recordEvent(leave.id, me.id, timelineType, { note }, t);
    if (after) await after(t);
  });
  return { before: participants, result };
};

const workflowError = (res, err) => {
  if (err instanceof WorkflowError) return error(res, err.message, 400, { code: err.code });
  return null;
};

/** POST /api/hr/me/leave/:id/reply { note } — answers every open question. */
const reply = async (req, res) => {
  const note = clip(req.body?.note, 4000);
  if (!note) return error(res, 'Write your answer', 400, { code: 'NOTE_REQUIRED' });
  try {
    const me = await loadMe(req.user.id);
    const leave = await findMine(req);
    if (!leave) return error(res, 'Leave request not found', 404);
    const { before } = await transition(leave, me, 'reply', { timelineType: 'info_replied', note });

    const askers = before.filter((p) => p.decision === DECISION.INFO).map((p) => p.userId);
    await hrNotify.notify('leave_info_replied', {
      recipients: askers,
      title: `${fullName(me)} answered your question`,
      body: `About their leave request (${rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10))}). Open the HMS to read the answer and decide.`,
      link: approverLink(leave.id),
      actorName: fullName(me),
    });

    await leave.reload({ include: detailIncludes() });
    return success(res, formatApplication(leave, { typeNames: await typeNameMap() }));
  } catch (err) {
    if (workflowError(res, err)) return undefined;
    console.error('SelfLeave.reply error:', err);
    return error(res, 'Failed to send your answer', 500);
  }
};

/** Everyone on the request, for "withdrawn" / "asks to cancel" notices. */
const everyoneOn = (leave) => leave.participants.map((p) => p.UserId);

/** POST /api/hr/me/leave/:id/withdraw { note? } — while still waiting. Releases the days. */
const withdraw = async (req, res) => {
  try {
    const me = await loadMe(req.user.id);
    const leave = await findMine(req);
    if (!leave) return error(res, 'Leave request not found', 404);
    await transition(leave, me, 'withdraw', {
      timelineType: 'withdrawn',
      note: clip(req.body?.note, 2000),
      after: (t) => leaveService.releaseCharges(leave.id, t),
    });

    await hrNotify.notify('leave_cancelled', {
      recipients: everyoneOn(leave),
      title: `${fullName(me)} withdrew a leave request`,
      body: `${rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10))}. Nothing more is needed from you.`,
      link: approverLink(leave.id),
      actorName: fullName(me),
    });

    await leave.reload({ include: detailIncludes() });
    return success(res, formatApplication(leave, { typeNames: await typeNameMap() }));
  } catch (err) {
    if (workflowError(res, err)) return undefined;
    console.error('SelfLeave.withdraw error:', err);
    return error(res, 'Failed to withdraw the request', 500);
  }
};

/**
 * POST /api/hr/me/leave/:id/cancel-request { note? } — approved leave that has
 * not started. It stays approved (and its days stay charged) until an approver
 * or HR cancels it (phase 3).
 */
const cancelRequest = async (req, res) => {
  try {
    const me = await loadMe(req.user.id);
    const leave = await findMine(req);
    if (!leave) return error(res, 'Leave request not found', 404);
    await transition(leave, me, 'cancel_request', { timelineType: 'cancel_requested', note: clip(req.body?.note, 2000) });

    const approvers = leave.participants.filter((p) => p.kind === KIND.APPROVER).map((p) => p.UserId);
    await hrNotify.notify('leave_cancelled', {
      recipients: approvers,
      title: `${fullName(me)} asks to cancel approved leave`,
      body: `${rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10))}. Open the HMS to cancel it.`,
      link: approverLink(leave.id),
      actorName: fullName(me),
    });

    await leave.reload({ include: detailIncludes() });
    return success(res, formatApplication(leave, { typeNames: await typeNameMap() }));
  } catch (err) {
    if (workflowError(res, err)) return undefined;
    console.error('SelfLeave.cancelRequest error:', err);
    return error(res, 'Failed to ask for the cancellation', 500);
  }
};

/**
 * PATCH /api/hr/me/leave/:id/attachment { documentId } — adds the supporting
 * document the applicant owed. The document is uploaded first through the
 * staff file's own self-upload (POST /api/staff/:employeeId/documents) and
 * must be theirs.
 */
const addAttachment = async (req, res) => {
  try {
    const leave = await findMine(req);
    if (!leave) return error(res, 'Leave request not found', 404);
    if ([STATUS.WITHDRAWN, STATUS.CANCELLED, STATUS.REJECTED].includes(leave.status)) {
      return error(res, 'This request is closed.', 400, { code: 'CLOSED' });
    }
    const doc = await StaffDocument.findOne({ where: { id: Number(req.body?.documentId), UserId: req.user.id, isArchived: false } });
    if (!doc) return error(res, 'That document is not one of yours.', 400, { code: 'BAD_DOCUMENT' });

    await sequelize.transaction(async (t) => {
      await leave.update({ attachmentDocumentId: doc.id, updatedBy: req.user.id }, { transaction: t });
      await leaveService.recordEvent(leave.id, req.user.id, 'document_added', { data: { documentId: doc.id } }, t);
    });

    await leave.reload({ include: detailIncludes() });
    return success(res, formatApplication(leave, { typeNames: await typeNameMap() }));
  } catch (err) {
    console.error('SelfLeave.addAttachment error:', err);
    return error(res, 'Failed to add the document', 500);
  }
};

/**
 * GET /api/hr/me/approvers?q= — active colleagues to choose from. Says who can
 * approve leave (leave.approve, admin.access included) and suggests the line
 * manager (StaffProfile.reportsToId).
 */
const approvers = async (req, res) => {
  try {
    const me = await loadMe(req.user.id);
    if (!me) return error(res, 'Account not found', 404);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const where = { id: { [Op.ne]: me.id }, isActive: true, role: { [Op.in]: INTERNAL_ROLES } };
    if (q) {
      where[Op.or] = [
        { firstName: { [Op.like]: `%${q}%` } },
        { lastName: { [Op.like]: `%${q}%` } },
        sequelize.where(sequelize.fn('CONCAT', sequelize.col('firstName'), ' ', sequelize.col('lastName')), { [Op.like]: `%${q}%` }),
      ];
    }
    const users = await User.findAll({
      where,
      attributes: ['id', 'firstName', 'lastName', 'role', 'permissions', 'deniedPermissions', 'staffType'],
      include: [{ model: StaffProfile, attributes: ['position', 'deletedAt'], required: false }],
      order: [['firstName', 'ASC'], ['lastName', 'ASC']],
      limit: 200,
    });
    const suggestedId = me.StaffProfile?.reportsToId || null;
    const people = users
      .filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt)
      .map((u) => ({
        id: u.id,
        name: fullName(u),
        role: u.role,
        position: u.StaffProfile?.position || null,
        canApprove: passesAdminGate(u, PERMISSIONS.LEAVE_APPROVE),
        suggested: u.id === suggestedId,
      }));
    return success(res, { people, suggestedId });
  } catch (err) {
    console.error('SelfLeave.approvers error:', err);
    return error(res, 'Failed to load colleagues', 500);
  }
};

module.exports = {
  overview,
  preview,
  submit,
  getOne,
  reply,
  withdraw,
  cancelRequest,
  addAttachment,
  approvers,
  // for phase 3 and the tests
  evaluate,
  buildOverview,
  loadMe,
  fullName,
  rangeText,
  daysText,
  approverLink,
  applicantLink,
  typeForNotice,
  formatApplication,
  detailIncludes,
  typeNameMap,
};
