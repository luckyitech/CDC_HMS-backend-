// Staff leave on the staff file — the list, recording, deciding, entitlement.
//
// findStaff has already resolved :employeeId onto req.staffProfile and
// req.staffUser before any of these run. See STAFF_PROFILE_DESIGN.md.
//
// B27 phase 0 (28 Sep 2026): the rules now live in utils/leaveCalc,
// utils/leaveBalance and utils/leaveWorkflow, and the database side in
// services/leaveService. This controller keeps the pre-B27 staff-file screen
// working on the new tables:
//   - leave types come from LeaveTypes, not an ENUM;
//   - days may be half days (DECIMAL) once a year's policy is published;
//   - every leave has LeaveCharges (which balance it came off) and a
//     LeaveEvents timeline; balances are summed from charges;
//   - deciding is leave.approve / leave.manage, entitlement is leave.policy
//     (were users.write) — decision D8;
//   - sick leave's type and reason are shown only to the person and to
//     leave.manage holders (spec §11 — health data).
// Phase 3 (Approve, 28 Sep 2026): the staff-file Leave tab now shows the same
// overview as My leave (hrSelfLeaveController.buildOverview), recording is
// "record on behalf" — leave.manage, never your own file, approved on the spot
// — and deciding moved to the approvals inbox (/api/leave/requests/:id,
// leaveApprovalController). The old PATCH decide route is gone.
// applyApprovalSideEffects / removeApprovalSideEffects stay here and are reused.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { datesInRange } = require('../utils/leaveCalc');
const { STATUS, TAKEN_STATUSES } = require('../utils/leaveWorkflow');
const { PERMISSIONS, passesAdminGate } = require('../constants/permissions');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');
const leaveService = require('../services/leaveService');
const hrNotify = require('../services/hrNotify');
const { buildOverview, evaluate, loadMe, fullName, rangeText, daysText, applicantLink } = require('./hrSelfLeaveController');
const db = require('../models');
const sequelize = require('../config/database');

const { StaffLeave, LeaveBalance, StaffProfile, DoctorBlock, User } = db;

// The seven original types. Kept as an export for older callers; the live list
// is LeaveTypes (leaveService.listTypes).
const LEAVE_TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];

// Blocking a whole day rather than individual slots. DoctorBlock already
// supports 'ALL_DAY' and the booking screens understand it.
const ALL_DAY = 'ALL_DAY';

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** May this person see and manage everyone's leave? leave.manage, admin.access included. */
const canManageLeave = (user) => passesAdminGate(user, PERMISSIONS.LEAVE_MANAGE);

/**
 * May this person decide (approve/decline) THIS staff member's leave?
 *
 * Nobody decides their own leave, whatever they hold (Emu, 24 Sep 2026).
 * Beyond that: a leave.manage holder may decide anyone's; a leave.approve
 * holder only a request they were listed on as an approver (B27 D5 — the
 * applicant picks the approvers). Leave recorded on the staff file before the
 * application wizard has no approvers listed, so only leave.manage decides it.
 */
const canDecideLeaveFor = (actingUser, staffUser, { isListedApprover = false } = {}) => {
  if (!actingUser || !staffUser || actingUser.id === staffUser.id) return false;
  if (canManageLeave(actingUser)) return true;
  return isListedApprover && passesAdminGate(actingUser, PERMISSIONS.LEAVE_APPROVE);
};

/**
 * One leave row for the screen. A viewer without leave.manage looking at
 * someone else's file sees private types (sick) as "Private" and no reasons.
 */
const formatLeave = (leave, { redact = false } = {}) => {
  const hide = redact && leaveService.PRIVATE_TYPES.has(leave.leaveType);
  const charges = (leave.charges || []).filter((c) => c.status === 'active')
    .map((c) => ({ leaveType: redact && leaveService.PRIVATE_TYPES.has(c.leaveType) ? 'Private' : c.leaveType, days: num(c.days) }));
  return {
    id:          leave.id,
    leaveType:   hide ? 'Private' : leave.leaveType,
    startDate:   leave.startDate,
    endDate:     leave.endDate,
    startPart:   leave.startPart || 'full',
    endPart:     leave.endPart || 'full',
    days:        num(leave.days),
    reason:      redact ? null : leave.reason,
    status:      leave.status,
    approvedAt:  leave.approvedAt,
    approvedBy:  leave.approvedBy ? `${leave.approvedBy.firstName} ${leave.approvedBy.lastName}` : null,
    decisionNote: redact ? null : leave.decisionNote,
    returnDate:  leave.returnDate || null,
    onBehalf:    !!leave.onBehalf,
    charges,
    blocksAppointments: (parseJsonColumn(leave.doctorBlockIds) || []).length > 0,
    createdAt:   leave.createdAt,
  };
};

const withDetail = () => [
  { model: User, as: 'approvedBy', attributes: ['firstName', 'lastName'] },
  { association: 'charges', required: false },
];

/**
 * GET /api/staff/:employeeId/leaves?year=2026
 * The person's leave for the year — the same overview My leave shows
 * (balances, applications with where each stands, coming up).
 *
 * Authorization: the staff member themselves, leave.manage, or users.view
 * (leaveViewOrSelf in routes/staff.js). A users.view holder without
 * leave.manage sees someone else's sick leave as "Private", no reasons, and
 * no sick balance.
 */
const list = async (req, res) => {
  const today = clinicToday();
  const year = parseInt(req.query.year, 10) || Number(today.slice(0, 4));
  const userId = req.staffUser.id;
  const redact = req.user.id !== userId && !canManageLeave(req.user);

  try {
    const data = await buildOverview({ userId, year, today, redact });
    if (!data) return error(res, 'Staff member not found', 404);
    // What HR may record on this person's behalf: every type in use this year,
    // including ones staff don't see (D10) — only for leave.manage.
    let recordTypes = null;
    if (canManageLeave(req.user) && req.user.id !== userId) {
      const [types, policy] = await Promise.all([leaveService.listTypes(), leaveService.loadPolicy(year)]);
      recordTypes = types.filter((t) => !policy || policy.types[t.key]?.enabled)
        .map((t) => ({ key: t.key, name: t.name, halfDaysAllowed: policy ? !!policy.types[t.key]?.halfDaysAllowed : false }));
    }
    return success(res, { ...data, redacted: redact, recordTypes });
  } catch (err) {
    console.error('StaffLeave.list error:', err);
    return error(res, 'Failed to load leave', 500);
  }
};

/**
 * POST /api/staff/:employeeId/leaves/preview
 * HR's calculator for recording on someone's behalf — the same judgement the
 * applicant's wizard uses (hrSelfLeaveController.evaluate), in HR mode: hidden
 * types allowed, no notice warning, a short balance warns instead of blocking.
 */
const previewOnBehalf = async (req, res) => {
  try {
    const staffUser = await loadMe(req.staffUser.id);
    const result = await evaluate({ user: staffUser, body: req.body || {}, today: clinicToday(), asHr: true });
    return success(res, result);
  } catch (err) {
    console.error('StaffLeave.previewOnBehalf error:', err);
    return error(res, 'Failed to work out those dates', 500);
  }
};

/**
 * POST /api/staff/:employeeId/leaves — RECORD ON BEHALF (phase 3).
 * HR records leave someone has taken or will take — a phone call from home, a
 * hidden type — approved on the spot, with its charge, an event 'recorded' and
 * the approval side effects. The person is told.
 *
 * Authorization: leave.manage at the route. Inline: never your own file —
 * your own leave goes through My leave and someone else decides it.
 */
const create = async (req, res) => {
  const staffUser = req.staffUser;
  if (staffUser.id === req.user.id) {
    return error(res, 'Apply for your own leave through My leave — someone else decides it.', 403, { code: 'OWN_LEAVE' });
  }

  try {
    const today = clinicToday();
    const person = await loadMe(staffUser.id);
    const result = await evaluate({ user: person, body: req.body || {}, today, asHr: true });
    if (!result.ok) {
      const first = result.errors[0];
      return error(res, first.message, result.status, { code: first.code, errors: result.errors });
    }

    const actor = await loadMe(req.user.id);
    const now = new Date();
    const reason = typeof req.body.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 2000) : null;

    const leave = await sequelize.transaction(async (t) => {
      const row = await StaffLeave.create({
        UserId:       staffUser.id,
        leaveType:    result.leaveType,
        startDate:    result.startDate,
        endDate:      result.endDate,
        startPart:    result.startPart,
        endPart:      result.endPart,
        days:         result.total,
        reason,
        status:       STATUS.APPROVED,
        approvedById: req.user.id,
        approvedAt:   now,
        submittedAt:  now,
        policyYear:   result.policyYear,
        breakdown:    {
          ...(result.breakdown || {}),
          usedPolicy: result.usedPolicy,
          backdated: result.warnings.some((w) => w.code === 'BACKDATED'),
          documentNeeded: false,
          clashNames: [],
        },
        returnDate:   result.returnDate,
        onBehalf:     true,
        createdBy:    req.user.id,
      }, { transaction: t });

      await leaveService.setCharges(row.id, [{ leaveType: result.leaveType, days: result.total }], req.user.id, t);
      await leaveService.recordEvent(row.id, req.user.id, 'recorded', {
        data: { status: row.status, days: result.total, leaveType: result.leaveType },
      }, t);
      return row;
    });

    const policy = await leaveService.loadPolicy(result.policyYear);
    await applyApprovalSideEffects(leave, person, actor, { blockDoctorSlots: policy ? policy.blockDoctorSlots : true });

    await hrNotify.notify('leave_decided', {
      recipients: [staffUser.id],
      title: 'HR recorded leave for you',
      body: `${rangeText(result.startDate, result.endDate)} · ${daysText(result.total)}. Open the HMS to see it.`,
      link: applicantLink(leave.id),
      actorName: fullName(actor),
    });

    await leave.reload({ include: withDetail() });
    return success(res, formatLeave(leave), 201);
  } catch (err) {
    console.error('StaffLeave.create error:', err);
    return error(res, 'Failed to record leave', 500);
  }
};

/**
 * Everything that follows from approving leave, kept in one place so approving
 * on creation and approving later behave identically.
 *
 * For a doctor this writes one all-day DoctorBlock per date, so reception
 * cannot book someone who is away — without it, the leave is recorded and the
 * appointment book carries on as if they were in. (Every date in the range,
 * weekends and holidays included — a block on a day off does no harm, and a
 * doctor who works a Saturday clinic by arrangement must not be bookable.)
 */
const applyApprovalSideEffects = async (leave, staffUser, actingUser, { blockDoctorSlots = true } = {}) => {
  // The policy's "Block a doctor's slots on approval" (phase 1). Before any
  // policy is published the old behaviour — always block — stands.
  if (staffUser.role === 'doctor' && blockDoctorSlots) {
    const blockIds = [];

    for (const date of datesInRange(leave.startDate, leave.endDate)) {
      // findOrCreate rather than create: DoctorBlock has a unique index on
      // (doctorId, date, timeSlot), and the doctor may already have blocked
      // that day themselves. Approving leave should not fail because of that.
      const [block] = await DoctorBlock.findOrCreate({
        where: { doctorId: staffUser.id, date, timeSlot: ALL_DAY },
        defaults: {
          blockedBy: `${actingUser.firstName} ${actingUser.lastName}`,
          // Never the leave type: this shows on the appointment book, and
          // sick leave is health data (B27 spec §11).
          reason: 'On leave',
        },
      });
      blockIds.push(block.id);
    }

    await leave.update({ doctorBlockIds: blockIds });
  }

  // Reflected on the profile so the header pill tells the truth today. Login is
  // deliberately NOT disabled — someone on annual leave should still be able to
  // sign in; suspension is what blocks access. Only an Active profile flips:
  // leave never overwrites Suspended / Resigned / Terminated.
  const today = clinicToday();
  if (leave.startDate <= today && leave.endDate >= today) {
    await StaffProfile.update(
      { employmentStatus: 'On Leave' },
      { where: { UserId: staffUser.id, employmentStatus: 'Active' } }
    );
  }
};

/**
 * Undoes approval. Only the blocks this leave created are removed — matching by
 * date instead would also delete blocks the doctor set for their own reasons.
 */
const removeApprovalSideEffects = async (leave, staffUser) => {
  // Through parseJsonColumn: MariaDB hands a JSON column back as a string, and
  // Array.isArray on the string quietly skipped the delete (caught 28 Sep on
  // the scratch DB — prod MySQL returns an array, so prod was never affected).
  const parsed = parseJsonColumn(leave.doctorBlockIds);
  const ids = Array.isArray(parsed) ? parsed : [];

  if (ids.length) {
    await DoctorBlock.destroy({ where: { id: { [Op.in]: ids } } });
    await leave.update({ doctorBlockIds: null });
  }

  // Only step the profile back out of 'On Leave' if no other approved leave
  // covers today, or cancelling one of two overlapping absences would mark
  // someone present while they are still away.
  const today = clinicToday();
  const stillOnLeave = await StaffLeave.count({
    where: {
      UserId: staffUser.id,
      status: { [Op.in]: TAKEN_STATUSES },
      startDate: { [Op.lte]: today },
      endDate:   { [Op.gte]: today },
    },
  });

  if (!stillOnLeave) {
    await StaffProfile.update(
      { employmentStatus: 'Active' },
      { where: { UserId: staffUser.id, employmentStatus: 'On Leave' } }
    );
  }
};

/**
 * PUT /api/staff/:employeeId/leave-balances
 * Sets this person's entitlement for a year — the per-person override on top
 * of the clinic policy (D1). Accepts a list so a whole year is configured in
 * one call.
 *
 * A figure equal to the published policy's is stored as "follow the policy"
 * (null), so saving the whole list from the staff file does not freeze every
 * type at today's policy number. Every save carries a reason (default
 * "Set on the staff file").
 *
 * Authorization: leave.policy (was users.write).
 */
const setBalances = async (req, res) => {
  const { year, balances } = req.body;
  const reason = typeof req.body.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim().slice(0, 2000)
    : 'Set on the staff file';
  const userId = req.staffUser.id;

  try {
    const known = new Set((await leaveService.listTypes({ includeRetired: true })).map((t) => t.key));
    const bad = balances.find((b) => !known.has(b.leaveType));
    if (bad) return error(res, `Unknown leave type: ${bad.leaveType}`, 400);

    await leaveService.saveOverrides({ userId, year, balances, reason, actorId: req.user.id, policyMode: 'published' });

    const saved = await LeaveBalance.findAll({ where: { UserId: userId, year } });
    return success(res, saved.map((b) => ({
      leaveType: b.leaveType, year: b.year, entitled: num(b.entitled), carriedOver: num(b.carriedOver), reason: b.reason,
    })));
  } catch (err) {
    console.error('LeaveBalance.set error:', err);
    return error(res, 'Failed to save leave entitlement', 500);
  }
};

module.exports = {
  list,
  previewOnBehalf,
  create,
  setBalances,
  applyApprovalSideEffects,
  removeApprovalSideEffects,
  LEAVE_TYPES,
  canDecideLeaveFor,
  canManageLeave,
  formatLeave,
};
