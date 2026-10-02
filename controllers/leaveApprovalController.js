// Deciding leave — B27 phase 3 (Approve). /api/leave/inbox, /api/leave/requests/:id…
//
// The applicant chose the people (phase 2). APPROVERS must ALL approve;
// ACKNOWLEDGERS are only told (D5). Any approver may approve, decline or ask
// for more information — a note is required for the last two (D6). An approver
// who holds leave.approve may change which balance(s) the days come off; the
// approval that completes the request LOCKS the split (D7, revision B). Every
// change is a LeaveEvent the applicant sees.
//
// Who may open a request: the applicant, anyone on it, or leave.manage — and,
// READ-ONLY and redacted, a users.view holder opening it from the staff file
// (B27 debt fix, 2 Oct 2026: they already see the row on the staff file's Leave
// tab; they never see a private type, a reason, a note or the document, and
// cannot act). Anyone else gets 404 — not 403 — so the existence of someone's
// leave is not leaked.
// Who sees a private type (sick) and its reason: the applicant, the approvers
// and leave.manage. Acknowledgers see "Private" (health data, spec §11).
//
// Nobody decides their own leave, whatever they hold. leave.manage does not
// override the approvers the applicant chose — except on a request recorded
// before B27 with no approvers at all, which only leave.manage can decide
// (the manager is added as its approver, on the timeline).
//
// The rules are pure (utils/leaveWorkflow, utils/leaveBalance, utils/leaveApply);
// the side effects of approval are leaveController.applyApprovalSideEffects,
// shared with record-on-behalf.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { datesInRange } = require('../utils/leaveCalc');
const { checkBalance } = require('../utils/leaveBalance');
const { clashes } = require('../utils/leaveApply');
const {
  STATUS, OPEN_STATUSES, TAKEN_STATUSES, KIND, DECISION, WorkflowError, applyEvent, isLastApprover, chargeValid,
} = require('../utils/leaveWorkflow');
const { PERMISSIONS, passesAdminGate } = require('../constants/permissions');
const { resolveStoredFile } = require('../utils/staffDocumentStorage');
const { sendCsv } = require('../utils/csv');
const { recordSettingChanges } = require('../services/settingChangeLog');
const leaveService = require('../services/leaveService');
const hrNotify = require('../services/hrNotify');
const {
  formatApplication, detailIncludes, typeNameMap, loadMe, fullName, rangeText, daysText, approverLink, applicantLink,
} = require('./hrSelfLeaveController');
const { applyApprovalSideEffects, removeApprovalSideEffects } = require('./leaveController');
const db = require('../models');
const sequelize = require('../config/database');

const { StaffLeave, LeaveParticipant, StaffDocument, StaffProfile, User } = db;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const canManage = (user) => passesAdminGate(user, PERMISSIONS.LEAVE_MANAGE);
const canViewStaff = (user) => passesAdminGate(user, PERMISSIONS.USERS_VIEW);
const holdsApprove = (user) => passesAdminGate(user, PERMISSIONS.LEAVE_APPROVE);

const LIVE = [...OPEN_STATUSES, ...TAKEN_STATUSES];

const WORKFLOW_HTTP = { NOT_APPROVER: 403, FORBIDDEN: 403 };

// ---------------------------------------------------------------------------
// Loading and access
// ---------------------------------------------------------------------------

const applicantInclude = () => ({
  model: User,
  attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'],
  include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department', 'deletedAt'], required: false }],
});

const loadRequest = (id) => StaffLeave.findByPk(Number(id), { include: [...detailIncludes(), applicantInclude()] });

/** How this viewer stands to this request. */
const standing = (leave, user) => {
  const participant = (leave.participants || []).find((p) => p.UserId === user.id) || null;
  const isApplicant = leave.UserId === user.id;
  const manage = canManage(user);
  const isApprover = participant?.kind === KIND.APPROVER;
  const approvers = (leave.participants || []).filter((p) => p.kind === KIND.APPROVER);
  const legacy = approvers.length === 0;          // recorded before B27 — nobody listed
  return {
    isApplicant,
    participant,
    isApprover,
    isAcknowledger: participant?.kind === KIND.ACKNOWLEDGER,
    // HR Tier 2 — the cover person: opens it (redacted — dates only), answers
    // "I'll cover" / "I can't cover"; never decides.
    isCover: participant?.kind === KIND.COVER,
    manage,
    legacy,
    // users.view: read-only and redacted (see the header).
    viewOnly: !(isApplicant || participant || manage) && canViewStaff(user),
    mayOpen: isApplicant || !!participant || manage || canViewStaff(user),
    // Health data: applicant, approvers and leave.manage see a private type.
    redact: !(isApplicant || isApprover || manage),
  };
};

const participantsPlain = (leave) => (leave.participants || []).map((p) => ({
  id: p.id, userId: p.UserId, kind: p.kind, decision: p.decision,
}));

/** Types a split may use: enabled in the request's year (all active before a policy). */
const chargeableTypes = async (policy) => {
  const types = await leaveService.listTypes();
  return types.filter((t) => !policy || policy.types[t.key]?.enabled);
};

// ---------------------------------------------------------------------------
// The request, as an approver sees it (mockup 3)
// ---------------------------------------------------------------------------

/**
 * Balances for the tiles and the split: per type, what was left BEFORE this
 * request, what is left after it, taken this year.
 */
const balancesFor = async (leave, policy) => {
  const year = Number(String(leave.startDate).slice(0, 4));
  const today = clinicToday();
  const asOf = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
  const picture = await leaveService.summaryFor(leave.UserId, year, asOf, { policy });
  const mine = {};
  for (const c of (leave.charges || []).filter((x) => x.status === 'active')) mine[c.leaveType] = num(c.days);
  const taken = TAKEN_STATUSES.includes(leave.status);
  return picture.summary.map((s) => {
    const here = mine[s.leaveType] || 0;
    // Summaries already count this request (taken if approved, booked if waiting).
    const before = s.unlimited || s.remaining === null ? null : round2(s.remaining + (taken ? here : 0));
    return {
      leaveType: s.leaveType,
      name: s.name,
      unlimited: s.unlimited,
      leftBefore: before,
      leftAfter: before === null ? null : round2(before - here),
      takenThisYear: round2(s.taken - (taken ? here : 0)),
      otherWaiting: round2(s.booked - (taken ? 0 : here)),
    };
  });
};

/** "Who else is away": same-role colleagues over the request's dates, and the holidays. */
const awayStrip = async (leave) => {
  const start = String(leave.startDate).slice(0, 10);
  const end = String(leave.endDate).slice(0, 10);
  const others = await StaffLeave.findAll({
    where: {
      UserId: { [Op.ne]: leave.UserId },
      status: { [Op.in]: LIVE },
      startDate: { [Op.lte]: end },
      endDate: { [Op.gte]: start },
    },
    attributes: ['UserId', 'startDate', 'endDate', 'status'],
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role'], where: { role: leave.User?.role || '', isActive: true } }],
  });
  const holidays = await leaveService.loadHolidays(start, end);
  const policy = await leaveService.loadPolicy(Number(start.slice(0, 4)));
  const c = clashes({
    start, end,
    others: others.map((o) => ({ userId: o.UserId, name: fullName(o.User), startDate: o.startDate, endDate: o.endDate })),
    maxPerDay: policy ? policy.maxCadreAwayPerDay : null,
    skipDates: new Set(holidays.map((h) => h.date)),
  });
  // Rows for the strip — names, dates and approved/waiting only. Never the type.
  const rows = others.map((o) => ({
    name: fullName(o.User),
    from: String(o.startDate).slice(0, 10) < start ? start : String(o.startDate).slice(0, 10),
    to: String(o.endDate).slice(0, 10) > end ? end : String(o.endDate).slice(0, 10),
    approved: TAKEN_STATUSES.includes(o.status),
  })).sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
  const dates = datesInRange(start, end);
  return { dates: dates.length <= 62 ? dates : null, holidays, rows, overLimit: c.overLimit };
};

const detailFor = async (leave, user) => {
  const st = standing(leave, user);
  const typeNames = await typeNameMap();
  const today = clinicToday();
  const policy = await leaveService.loadPolicy(Number(String(leave.startDate).slice(0, 4)));
  const open = OPEN_STATUSES.includes(leave.status);
  const participants = participantsPlain(leave);
  const myDecision = st.participant?.decision || null;

  const canDecide = !st.isApplicant && open && (
    (st.isApprover && myDecision !== DECISION.APPROVED)
    || (st.legacy && st.manage)
  );
  const canSplit = canDecide && holdsApprove(user);
  const isLast = canDecide && (st.legacy || isLastApprover(participants, user.id));
  // The cover person answers while the leave is live and not yet over; they may change their answer.
  const coverLive = [...OPEN_STATUSES, STATUS.APPROVED, STATUS.CANCEL_REQUESTED].includes(leave.status)
    && String(leave.endDate).slice(0, 10) >= today;
  const canAnswerCover = st.isCover && coverLive;
  const canCancel = !st.isApplicant && (
    (st.manage && [...OPEN_STATUSES, STATUS.APPROVED, STATUS.CANCEL_REQUESTED].includes(leave.status))
    || (st.isApprover && leave.status === STATUS.CANCEL_REQUESTED)
  );

  const [balances, types, away] = await Promise.all([
    st.redact ? null : balancesFor(leave, policy),
    canSplit ? chargeableTypes(policy) : null,
    awayStrip(leave),
  ]);

  const profile = leave.User?.StaffProfile;
  return {
    application: formatApplication(leave, { typeNames, redact: st.redact, today, datesOnly: st.isCover }),
    applicant: {
      id: leave.UserId,
      name: fullName(leave.User) || 'Former colleague',
      role: leave.User?.role || null,
      employeeId: profile && !profile.deletedAt ? profile.employeeId : null,
      position: profile?.position || null,
    },
    balances: balances ? balances.filter((b) => !st.redact || !leaveService.PRIVATE_TYPES.has(b.leaveType)) : null,
    chargeTypes: types ? types.map((t) => ({ key: t.key, name: t.name })) : null,
    policyPublished: !!policy,
    allowNegative: policy ? !!policy.allowNegative : true,
    away,
    me: {
      userId: user.id,
      isApplicant: st.isApplicant,
      isApprover: st.isApprover,
      isAcknowledger: st.isAcknowledger,
      manage: st.manage,
      legacy: st.legacy,
      myDecision,
      canDecide,
      canSplit,
      isLast,
      canCancel,
      viewOnly: st.viewOnly,
      isCover: st.isCover,
      canAnswerCover,
      canOpenDocument: !st.redact,
    },
  };
};

/** GET /api/leave/requests/:id */
const getRequest = async (req, res) => {
  try {
    const leave = await loadRequest(req.params.id);
    if (!leave || !standing(leave, req.user).mayOpen) return error(res, 'Leave request not found', 404);
    return success(res, await detailFor(leave, req.user));
  } catch (err) {
    console.error('LeaveApproval.get error:', err);
    return error(res, 'Failed to load the request', 500);
  }
};

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

const inboxRow = (leave, { typeNames, redact, me }) => {
  const mine = (leave.participants || []).find((p) => p.UserId === me);
  const a = formatApplication(leave, { typeNames, redact, datesOnly: mine?.kind === KIND.COVER });
  return {
    id: leave.id,
    applicant: fullName(leave.User) || 'Former colleague',
    applicantRole: leave.User?.role || null,
    typeName: a.typeName,
    leaveType: a.leaveType,
    startDate: a.startDate,
    endDate: a.endDate,
    days: a.days,
    status: a.status,
    submittedAt: a.submittedAt,
    participants: a.participants.map((p) => ({ kind: p.kind, decision: p.decision })),
    myDecision: mine?.decision || null,
    waitingOnMe: !!mine && (
      (mine.kind === KIND.APPROVER
        && ((OPEN_STATUSES.includes(leave.status) && mine.decision === DECISION.PENDING)
          || leave.status === STATUS.CANCEL_REQUESTED))
      || (mine.kind === KIND.COVER && mine.decision === DECISION.PENDING
        && [...OPEN_STATUSES, STATUS.APPROVED].includes(leave.status))),
    myKind: mine?.kind || null,
    flags: a.flags,
  };
};

/**
 * Requests where I'm an approver still to act: decisions pending on me and
 * asks to cancel. The inbox tab also keeps the ones where I asked a question
 * (`withAsked`); the badge counts only what is on me now.
 */
const waitingWhere = (me, { withAsked = true } = {}) => ({
  [Op.or]: [
    {
      status: { [Op.in]: OPEN_STATUSES },
      '$participants.UserId$': me,
      '$participants.kind$': KIND.APPROVER,
      '$participants.decision$': { [Op.in]: withAsked ? [DECISION.PENDING, DECISION.INFO] : [DECISION.PENDING] },
    },
    { status: STATUS.CANCEL_REQUESTED, '$participants.UserId$': me, '$participants.kind$': KIND.APPROVER },
    // HR Tier 2 — asked to cover and not yet answered.
    {
      status: { [Op.in]: [...OPEN_STATUSES, STATUS.APPROVED] },
      '$participants.UserId$': me,
      '$participants.kind$': KIND.COVER,
      '$participants.decision$': DECISION.PENDING,
    },
  ],
});

const idsWhere = async (where) => (await StaffLeave.findAll({
  where,
  attributes: ['id'],
  include: [{ model: LeaveParticipant, as: 'participants', attributes: [], required: true }],
  raw: true,
})).map((r) => r.id);

/**
 * GET /api/leave/inbox?tab=waiting|decided|all&year=
 *   waiting — I'm an approver and it waits on me (or on its asker, when I asked)
 *   decided — I approved or declined it
 *   all     — everyone's live requests (leave.manage)
 */
const inbox = async (req, res) => {
  const tab = ['waiting', 'decided', 'all'].includes(req.query.tab) ? req.query.tab : 'waiting';
  const me = req.user.id;
  try {
    const manage = canManage(req.user);
    if (tab === 'all' && !manage) return error(res, 'Only someone who manages leave sees everyone\'s', 403);

    let ids;
    if (tab === 'waiting') ids = await idsWhere(waitingWhere(me));
    else if (tab === 'decided') {
      ids = await idsWhere({
        '$participants.UserId$': me,
        '$participants.kind$': KIND.APPROVER,
        '$participants.decision$': { [Op.in]: [DECISION.APPROVED, DECISION.DECLINED] },
      });
    }

    const where = tab === 'all'
      ? (() => {
        const year = parseInt(req.query.year, 10) || Number(clinicToday().slice(0, 4));
        return { startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] }, status: { [Op.notIn]: [STATUS.WITHDRAWN] } };
      })()
      : { id: { [Op.in]: ids.length ? ids : [0] } };

    const leaves = await StaffLeave.findAll({
      where,
      include: [...detailIncludes(), applicantInclude()],
      order: [['startDate', tab === 'decided' ? 'DESC' : 'ASC'], ['id', 'ASC']],
      limit: 300,
    });
    const typeNames = await typeNameMap();
    const rows = leaves.map((l) => {
      const st = standing(l, req.user);
      return inboxRow(l, { typeNames, redact: st.redact, me });
    });
    const waiting = new Set(await idsWhere(waitingWhere(me, { withAsked: false }))).size;
    return success(res, { tab, rows, counts: { waiting }, manage });
  } catch (err) {
    console.error('LeaveApproval.inbox error:', err);
    return error(res, 'Failed to load leave to approve', 500);
  }
};

/** GET /api/leave/inbox/count — the sidebar badge: requests waiting on me. */
const inboxCount = async (req, res) => {
  try {
    const ids = await idsWhere(waitingWhere(req.user.id, { withAsked: false }));
    return success(res, { waiting: new Set(ids).size });
  } catch (err) {
    console.error('LeaveApproval.count error:', err);
    return error(res, 'Failed to count leave to approve', 500);
  }
};

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

const DECISION_EVENTS = { approve: 'approved', decline: 'declined', info: 'info_requested' };

const sameSplit = (a, b) => {
  const norm = (list) => list.map((c) => `${c.leaveType}:${round2(Number(c.days))}`).sort().join('|');
  return norm(a) === norm(b);
};

/**
 * Is this proposed split acceptable from this user? ONE judgement, used by
 * decide (with an approval) and saveSplit (without one).
 * → { split } (null = unchanged) or { fail: { message, status, extra } }
 */
const checkSplit = async (leave, charges, user, policy) => {
  const current = (leave.charges || []).filter((c) => c.status === 'active').map((c) => ({ leaveType: c.leaveType, days: num(c.days) }));
  const wanted = charges.map((c) => ({ leaveType: String(c?.leaveType || ''), days: Number(c?.days) }));
  if (sameSplit(wanted, current)) return { split: null };
  if (!holdsApprove(user)) {
    return { fail: { message: 'Only someone who can approve leave chooses which balance it comes off', status: 403, extra: { code: 'NO_SPLIT_RIGHT' } } };
  }
  const enabled = new Set((await chargeableTypes(policy)).map((t) => t.key));
  const valid = chargeValid(wanted, num(leave.days), enabled);
  if (!valid.ok) {
    const message = {
      SUM_MISMATCH: `The days must add up to ${num(leave.days)}`,
      TYPE_NOT_ENABLED: 'One of those balances is not in use this year',
      DUPLICATE_TYPE: 'Each balance once',
      BAD_DAYS: 'Days must be more than 0, in quarter days',
    }[valid.error] || 'Check the split';
    return { fail: { message, status: 400, extra: { code: valid.error } } };
  }
  if (policy && !policy.allowNegative) {
    // Take this request's own current charges back out before testing the new split.
    const year = Number(String(leave.startDate).slice(0, 4));
    const picture = await leaveService.summaryFor(leave.UserId, year, clinicToday(), { policy });
    const summary = picture.summary.map((s) => {
      const here = current.find((c) => c.leaveType === s.leaveType)?.days || 0;
      return { ...s, remainingAfterBooked: s.remainingAfterBooked === null ? null : round2(s.remainingAfterBooked + here) };
    });
    const bal = checkBalance({ summary, charges: wanted, allowNegative: false });
    if (!bal.ok) {
      return { fail: { message: 'That split takes a balance below zero', status: 409, extra: { code: 'INSUFFICIENT_BALANCE', short: bal.short } } };
    }
  }
  return { split: wanted };
};

/**
 * POST /api/leave/requests/:id/decide
 * { decision: 'approve'|'decline'|'info', note, charges?: [{ leaveType, days }] }
 */
const decide = async (req, res) => {
  const decision = req.body?.decision;
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 4000) : null;
  if (!DECISION_EVENTS[decision]) return error(res, 'Choose approve, decline or ask', 400, { code: 'BAD_DECISION' });
  if (decision !== 'approve' && !note) {
    return error(res, decision === 'decline' ? 'Say why you are declining' : 'Write your question', 400, { code: 'NOTE_REQUIRED' });
  }

  try {
    const leave = await loadRequest(req.params.id);
    if (!leave) return error(res, 'Leave request not found', 404);
    const st = standing(leave, req.user);
    if (!st.mayOpen) return error(res, 'Leave request not found', 404);
    if (st.isApplicant) return error(res, 'You cannot decide your own leave', 403, { code: 'OWN_LEAVE' });

    // A pre-B27 request nobody was listed on: leave.manage decides it, as its approver.
    const adopt = st.legacy && st.manage && !st.participant;
    let participants = participantsPlain(leave);
    if (adopt) participants = [...participants, { id: null, userId: req.user.id, kind: KIND.APPROVER, decision: DECISION.PENDING }];

    const result = applyEvent({ status: leave.status, participants, event: { type: decision, actorId: req.user.id } });

    // The split (revision B): only an approver holding leave.approve, only when approving.
    const policy = await leaveService.loadPolicy(Number(String(leave.startDate).slice(0, 4)));
    let split = null;
    if (Array.isArray(req.body?.charges) && decision === 'approve') {
      const checked = await checkSplit(leave, req.body.charges, req.user, policy);
      if (checked.fail) return error(res, checked.fail.message, checked.fail.status, checked.fail.extra);
      split = checked.split;
    }

    const now = new Date();
    await sequelize.transaction(async (t) => {
      if (adopt) {
        await LeaveParticipant.create({
          leaveId: leave.id, UserId: req.user.id, kind: KIND.APPROVER, decision: DECISION.PENDING, sortOrder: 0,
        }, { transaction: t });
      }
      const myNew = result.participants.find((p) => p.userId === req.user.id);
      await LeaveParticipant.update(
        { decision: myNew.decision, decidedAt: now, note },
        { where: { leaveId: leave.id, UserId: req.user.id }, transaction: t },
      );
      if (split) {
        const before = await leaveService.setCharges(leave.id, split, req.user.id, t);
        await leaveService.recordEvent(leave.id, req.user.id, 'charge_changed', { data: { from: before, to: split } }, t);
      }
      const patch = { status: result.status, updatedBy: req.user.id };
      if (result.final) Object.assign(patch, { approvedById: req.user.id, approvedAt: now, decisionNote: note });
      if (result.status === STATUS.REJECTED) patch.decisionNote = note;
      await leave.update(patch, { transaction: t });
      if (result.status === STATUS.REJECTED) await leaveService.releaseCharges(leave.id, t);
      await leaveService.recordEvent(leave.id, req.user.id, DECISION_EVENTS[decision], { note }, t);
    });

    const actor = await loadMe(req.user.id);
    const range = rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10));
    if (result.final) {
      const person = await loadMe(leave.UserId);
      await applyApprovalSideEffects(leave, person, actor, { blockDoctorSlots: policy ? policy.blockDoctorSlots : true });
      await hrNotify.notify('leave_decided', {
        recipients: [leave.UserId],
        title: 'Your leave is approved',
        body: `${range} · ${daysText(num(leave.days))}.`,
        link: applicantLink(leave.id),
        actorName: fullName(actor),
      });
      await hrNotify.notify('leave_acknowledge', {
        recipients: leave.participants.filter((p) => p.kind === KIND.ACKNOWLEDGER).map((p) => p.UserId),
        title: `${fullName(leave.User)}'s leave is approved`,
        body: `${range}. For your information.`,
        link: approverLink(leave.id),
        actorName: fullName(actor),
      });
    } else if (result.status === STATUS.REJECTED) {
      await hrNotify.notify('leave_decided', {
        recipients: [leave.UserId],
        title: 'Your leave request was declined',
        body: `${range}. Open the HMS to see why.`,
        link: applicantLink(leave.id),
        actorName: fullName(actor),
      });
    } else if (decision === 'info') {
      await hrNotify.notify('leave_info_requested', {
        recipients: [leave.UserId],
        title: `${fullName(actor)} has a question about your leave request`,
        body: `${range}. Open the HMS to read it and answer.`,
        link: applicantLink(leave.id),
        actorName: fullName(actor),
      });
    }

    const fresh = await loadRequest(leave.id);
    return success(res, await detailFor(fresh, req.user));
  } catch (err) {
    if (err instanceof WorkflowError) return error(res, err.message, WORKFLOW_HTTP[err.code] || 400, { code: err.code });
    console.error('LeaveApproval.decide error:', err);
    return error(res, 'Failed to record the decision', 500);
  }
};

/**
 * POST /api/leave/requests/:id/split { charges: [{ leaveType, days }] }
 * Save which balance(s) the days come off WITHOUT deciding (B27 debt fix,
 * 2 Oct 2026). Same right as changing it while approving: a listed approver
 * holding leave.approve who may still decide (canSplit). It does NOT lock —
 * only the approval that completes the request locks the split — and a later
 * approver may change it again. Logged as charge_changed, which the applicant
 * sees on the timeline.
 */
const saveSplit = async (req, res) => {
  if (!Array.isArray(req.body?.charges) || !req.body.charges.length) {
    return error(res, 'Say which balance(s) the days come off', 400, { code: 'BAD_DAYS' });
  }
  try {
    const leave = await loadRequest(req.params.id);
    if (!leave) return error(res, 'Leave request not found', 404);
    const st = standing(leave, req.user);
    if (!st.mayOpen) return error(res, 'Leave request not found', 404);
    if (st.isApplicant) return error(res, 'You cannot decide your own leave', 403, { code: 'OWN_LEAVE' });
    const detail = await detailFor(leave, req.user);
    if (!detail.me.canSplit) {
      return error(res, 'Only an approver who can approve leave, before approving, changes the split', 403, { code: 'NO_SPLIT_RIGHT' });
    }
    const policy = await leaveService.loadPolicy(Number(String(leave.startDate).slice(0, 4)));
    const checked = await checkSplit(leave, req.body.charges, req.user, policy);
    if (checked.fail) return error(res, checked.fail.message, checked.fail.status, checked.fail.extra);
    if (!checked.split) return error(res, 'That is already the split', 400, { code: 'NO_CHANGE' });

    await sequelize.transaction(async (t) => {
      const before = await leaveService.setCharges(leave.id, checked.split, req.user.id, t);
      await leaveService.recordEvent(leave.id, req.user.id, 'charge_changed', { data: { from: before, to: checked.split } }, t);
      await leave.update({ updatedBy: req.user.id }, { transaction: t });
    });

    const fresh = await loadRequest(leave.id);
    return success(res, await detailFor(fresh, req.user));
  } catch (err) {
    console.error('LeaveApproval.saveSplit error:', err);
    return error(res, 'Failed to save the split', 500);
  }
};

/**
 * POST /api/leave/requests/:id/cover { answer: 'agree'|'decline', note? }
 * HR Tier 2 (T2-1): the cover person says whether they can cover. Shown to the
 * applicant and the approvers; NEVER blocks or decides the request. They may
 * change their answer while the leave is live and not over. The applicant is
 * told (leave_cover_answered) — the notice carries no note.
 */
const answerCover = async (req, res) => {
  const answer = req.body?.answer;
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  if (!['agree', 'decline'].includes(answer)) return error(res, 'Say whether you can cover', 400, { code: 'BAD_ANSWER' });
  try {
    const leave = await loadRequest(req.params.id);
    if (!leave) return error(res, 'Leave request not found', 404);
    const st = standing(leave, req.user);
    if (!st.mayOpen) return error(res, 'Leave request not found', 404);
    const detail = await detailFor(leave, req.user);
    if (!detail.me.canAnswerCover) {
      return error(res, st.isCover ? 'This leave is over or closed.' : 'You are not the cover on this request.', 403, { code: 'NOT_COVER' });
    }
    const decision = answer === 'agree' ? DECISION.APPROVED : DECISION.DECLINED;
    if (st.participant.decision === decision) return error(res, 'That is already your answer', 400, { code: 'NO_CHANGE' });
    await sequelize.transaction(async (t) => {
      await LeaveParticipant.update({ decision, decidedAt: new Date(), note }, { where: { id: st.participant.id }, transaction: t });
      await leaveService.recordEvent(leave.id, req.user.id, answer === 'agree' ? 'cover_agreed' : 'cover_declined', { note }, t);
    });
    const actor = await loadMe(req.user.id);
    const range = rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10));
    await hrNotify.notify('leave_cover_answered', {
      recipients: [leave.UserId],
      title: answer === 'agree' ? `${fullName(actor)} will cover your work` : `${fullName(actor)} can't cover your work`,
      body: answer === 'agree' ? `${range}.` : `${range}. You may want to arrange someone else and tell your approvers.`,
      link: applicantLink(leave.id),
      actorName: fullName(actor),
    });
    const fresh = await loadRequest(leave.id);
    return success(res, await detailFor(fresh, req.user));
  } catch (err) {
    console.error('LeaveApproval.answerCover error:', err);
    return error(res, 'Failed to record your answer', 500);
  }
};

/**
 * POST /api/leave/requests/:id/cancel { note }
 * leave.manage: any live request. A listed approver: a request whose applicant
 * asked to cancel. Never your own — ask to cancel from My leave.
 */
const cancel = async (req, res) => {
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  try {
    const leave = await loadRequest(req.params.id);
    if (!leave) return error(res, 'Leave request not found', 404);
    const st = standing(leave, req.user);
    if (!st.mayOpen) return error(res, 'Leave request not found', 404);
    if (st.isApplicant) return error(res, 'Ask to cancel your own leave from My leave', 403, { code: 'OWN_LEAVE' });

    const wasTaken = TAKEN_STATUSES.includes(leave.status);
    const result = applyEvent({
      status: leave.status,
      participants: participantsPlain(leave),
      event: { type: 'cancel', actorId: req.user.id, canManage: st.manage },
    });

    await sequelize.transaction(async (t) => {
      await leave.update({ status: result.status, updatedBy: req.user.id }, { transaction: t });
      await leaveService.releaseCharges(leave.id, t);
      await leaveService.recordEvent(leave.id, req.user.id, 'cancelled', { note }, t);
    });
    if (wasTaken) await removeApprovalSideEffects(leave, await loadMe(leave.UserId));

    const actor = await loadMe(req.user.id);
    const range = rangeText(String(leave.startDate).slice(0, 10), String(leave.endDate).slice(0, 10));
    await hrNotify.notify('leave_cancelled', {
      recipients: [leave.UserId],
      title: 'Your leave was cancelled',
      body: `${range}. The days are back on your balance.`,
      link: applicantLink(leave.id),
      actorName: fullName(actor),
    });
    await hrNotify.notify('leave_cancelled', {
      recipients: leave.participants.map((p) => p.UserId).filter((id) => id !== req.user.id),
      title: `${fullName(leave.User)}'s leave was cancelled`,
      body: `${range}. Nothing more is needed from you.`,
      link: approverLink(leave.id),
      actorName: fullName(actor),
    });

    const fresh = await loadRequest(leave.id);
    return success(res, await detailFor(fresh, req.user));
  } catch (err) {
    if (err instanceof WorkflowError) return error(res, err.message, WORKFLOW_HTTP[err.code] || 400, { code: err.code });
    console.error('LeaveApproval.cancel error:', err);
    return error(res, 'Failed to cancel the leave', 500);
  }
};

/**
 * GET /api/leave/requests/:id/attachment — the supporting document, for the
 * applicant, the approvers and leave.manage (not acknowledgers — a sick note
 * is health data). Streams from private/ like the staff file does.
 */
const attachment = async (req, res) => {
  try {
    const leave = await loadRequest(req.params.id);
    if (!leave) return error(res, 'Leave request not found', 404);
    const st = standing(leave, req.user);
    if (!st.mayOpen || st.redact) return error(res, 'Leave request not found', 404);
    if (!leave.attachmentDocumentId) return error(res, 'No document on this request', 404);
    const doc = await StaffDocument.findOne({ where: { id: leave.attachmentDocumentId, UserId: leave.UserId } });
    if (!doc || doc.isArchived) return error(res, 'Document not found', 404);
    const resolved = resolveStoredFile(doc.filePath);
    if (!resolved) return error(res, 'File is missing from the server', 404);
    return res.download(resolved, doc.fileName);
  } catch (err) {
    console.error('LeaveApproval.attachment error:', err);
    return error(res, 'Failed to load the document', 500);
  }
};

// ---------------------------------------------------------------------------
// The leave register (HR Tier 2, T2-4 / T2-5)
// ---------------------------------------------------------------------------

const REGISTER_STATUS = {
  Pending: 'Waiting', InfoRequested: 'Question asked', Approved: 'Approved', Rejected: 'Declined',
  Withdrawn: 'Withdrawn', CancelRequested: 'Asked to cancel', Cancelled: 'Cancelled',
};
const COVER_ANSWER = { approved: 'agreed', declined: 'can\'t cover', pending: 'not answered' };
const fmtNum = (n) => (n === null || n === undefined ? '' : String(Math.round(Number(n) * 100) / 100));
const shortName = (u) => (u ? `${(u.firstName || '').charAt(0)} ${u.lastName || ''}`.trim() : '');

/**
 * GET /api/leave/register?year= — every request starting in the year, as a
 * .csv that opens in Excel (leave.manage). One row per request. It NAMES sick
 * leave (Emu, T2-4: only leave.manage can download, and they see it in the
 * HMS) — the file is health data once it leaves the HMS, so every download is
 * written to the Leave policy trail (who, when, which year).
 */
const register = async (req, res) => {
  const year = parseInt(req.query.year, 10) || Number(clinicToday().slice(0, 4));
  try {
    const leaves = await StaffLeave.findAll({
      where: { startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
      include: [...detailIncludes(), applicantInclude()],
      order: [['startDate', 'ASC'], ['id', 'ASC']],
    });
    const typeNames = await typeNameMap();
    const headers = ['Employee ID', 'Name', 'Role', 'Type', 'From', 'To', 'Days', 'Charged to', 'Status',
      'Approvers', 'Approved by', 'Cover', 'Recorded by HR', 'Applied on', 'Backdated'];
    const rows = leaves.map((l) => {
      const a = formatApplication(l, { typeNames, redact: false });
      const parts = l.participants || [];
      const approvers = parts.filter((p) => p.kind === KIND.APPROVER);
      const cover = parts.find((p) => p.kind === KIND.COVER);
      const profile = l.User?.StaffProfile;
      return [
        profile?.employeeId || '',
        fullName(l.User) || 'Former colleague',
        l.User?.role || '',
        typeNames[l.leaveType] || l.leaveType,
        a.startDate,
        a.endDate,
        fmtNum(a.days),
        a.charges.map((c) => `${typeNames[c.leaveType] || c.leaveType} ${fmtNum(c.days)}`).join('; '),
        REGISTER_STATUS[l.status] || l.status,
        approvers.map((p) => shortName(p.User)).join('; '),
        approvers.filter((p) => p.decision === DECISION.APPROVED).map((p) => shortName(p.User)).join('; '),
        cover ? `${shortName(cover.User)} (${COVER_ANSWER[cover.decision] || cover.decision})` : '',
        l.onBehalf ? 'Yes' : 'No',
        a.submittedAt ? new Date(a.submittedAt).toISOString().slice(0, 10) : '',
        a.flags?.backdated ? 'Yes' : 'No',
      ];
    });
    recordSettingChanges({
      user: req.user, area: 'Leave policy',
      before: { d: null }, after: { d: `${year} — ${rows.length} request${rows.length === 1 ? '' : 's'}` },
      fields: { d: { key: 'leave.register.download', label: 'Leave register downloaded' } },
    });
    return sendCsv(res, `leave-register-${year}.csv`, headers, rows);
  } catch (err) {
    console.error('LeaveApproval.register error:', err);
    return error(res, 'Failed to build the leave register', 500);
  }
};

module.exports = {
  register,
  inbox,
  inboxCount,
  getRequest,
  decide,
  saveSplit,
  answerCover,
  cancel,
  attachment,
  // tests
  standing,
};
