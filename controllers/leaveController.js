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
// The application and approval wizards (phases 2–3) replace the screens that
// call this; applyApprovalSideEffects / removeApprovalSideEffects are kept and
// reused by them.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { datesInRange, rangesOverlap } = require('../utils/leaveCalc');
const { STATUS, OPEN_STATUSES, TAKEN_STATUSES } = require('../utils/leaveWorkflow');
const { PERMISSIONS, passesAdminGate } = require('../constants/permissions');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');
const leaveService = require('../services/leaveService');
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
 * Balance for the year plus the full history.
 *
 * Authorization: the staff member themselves, leave.manage, or users.view
 * (leaveViewOrSelf in routes/staff.js). A users.view holder without
 * leave.manage sees someone else's sick leave as "Private" and no reasons.
 */
const list = async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const userId = req.staffUser.id;
  const redact = req.user.id !== userId && !canManageLeave(req.user);

  try {
    const [leaves, picture] = await Promise.all([
      StaffLeave.findAll({
        where: { UserId: userId, startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
        include: withDetail(),
        order: [['startDate', 'DESC']],
      }),
      leaveService.summaryFor(userId, year, clinicToday()),
    ]);

    const summary = picture.summary
      .filter((s) => !(redact && leaveService.PRIVATE_TYPES.has(s.leaveType)))
      .map((s) => ({
        leaveType:   s.leaveType,
        name:        s.name,
        // Pre-B27 fields, same meaning. `entitled` is 0 (not null) for a
        // type with no fixed allowance so the old screen keeps rendering.
        entitled:    s.entitled ?? 0,
        carriedOver: s.carriedIn,
        taken:       s.taken,
        remaining:   s.remaining,
        // B27 additions.
        unlimited:   s.unlimited,
        booked:      s.booked,
        available:   s.available,
        source:      s.source,
        proRated:    s.proRated,
        carriedLeft: s.carriedLeft,
        carriedLapsed: s.carriedLapsed,
        carryExpires: s.carryExpires,
        visible:     s.visible,
      }));

    return success(res, {
      year,
      policyPublished: !!picture.policy,
      summary,
      leaves: leaves.map((l) => formatLeave(l, { redact })),
    });
  } catch (err) {
    console.error('StaffLeave.list error:', err);
    return error(res, 'Failed to load leave', 500);
  }
};

/**
 * POST /api/staff/:employeeId/leaves
 * Records leave. A leave.manage holder recording for someone else approves it
 * on the spot (recorded on their behalf); anyone else — including a manager
 * recording their OWN leave — creates a pending request.
 *
 * Authorization: the staff member themselves, or users.view / leave.manage
 * (leaveViewOrSelf). Someone who may only VIEW another person's file can file
 * a request for them but not approve it.
 */
const create = async (req, res) => {
  const { leaveType, startDate, endDate, reason, excludeWeekends } = req.body;
  const startPart = req.body.startPart || 'full';
  const endPart = req.body.endPart || 'full';
  const user = req.staffUser;

  try {
    if (!(await leaveService.isActiveType(leaveType))) return error(res, 'Invalid leave type', 400);

    const cost = await leaveService.costOf({
      userId: user.id, leaveType, start: startDate, end: endDate, startPart, endPart, excludeWeekends,
    });
    if (!cost.ok) {
      const messages = {
        END_BEFORE_START: 'End date must be on or after the start date',
        HALF_DAYS_NEED_POLICY: 'Half days can be recorded once this year\'s leave policy is published',
        HALF_DAYS_NOT_ALLOWED: 'This leave type is taken in whole days',
        BAD_PART: 'A single day cannot both start after lunch and end at lunch',
      };
      return error(res, messages[cost.error] || 'Invalid dates', 400, { code: cost.error });
    }
    if (cost.total <= 0) {
      return error(res, 'Those dates are all days off or public holidays — there is nothing to take', 400, { code: 'ZERO_DAYS' });
    }

    // Two overlapping live requests would double-count against the balance
    // and, for a doctor, produce duplicate blocks on the same day.
    const nearby = await StaffLeave.findAll({
      where: {
        UserId: user.id,
        status: { [Op.in]: [...OPEN_STATUSES, ...TAKEN_STATUSES] },
        startDate: { [Op.lte]: endDate },
        endDate:   { [Op.gte]: startDate },
      },
    });
    const clash = nearby.find((l) => rangesOverlap(startDate, endDate, l.startDate, l.endDate));
    if (clash) {
      return error(
        res,
        `This overlaps existing ${clash.status.toLowerCase()} leave from ${clash.startDate} to ${clash.endDate}`,
        409
      );
    }

    const approveNow = canDecideLeaveFor(req.user, user);
    const now = new Date();

    const leave = await sequelize.transaction(async (t) => {
      const row = await StaffLeave.create({
        UserId:       user.id,
        leaveType,
        startDate,
        endDate,
        startPart,
        endPart,
        days:         cost.total,
        reason:       reason || null,
        status:       approveNow ? STATUS.APPROVED : STATUS.PENDING,
        approvedById: approveNow ? req.user.id : null,
        approvedAt:   approveNow ? now : null,
        submittedAt:  now,
        policyYear:   cost.policyYear,
        breakdown:    cost.breakdown,
        returnDate:   cost.returnDate,
        onBehalf:     approveNow,
        createdBy:    req.user.id,
      }, { transaction: t });

      await leaveService.setCharges(row.id, [{ leaveType, days: cost.total }], req.user.id, t);
      await leaveService.recordEvent(row.id, req.user.id, approveNow ? 'recorded' : 'submitted', {
        data: { status: row.status, days: cost.total, leaveType },
      }, t);
      return row;
    });

    if (approveNow) await applyApprovalSideEffects(leave, user, req.user);

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
const applyApprovalSideEffects = async (leave, staffUser, actingUser) => {
  if (staffUser.role === 'doctor') {
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
 * PATCH /api/staff/:employeeId/leaves/:id
 * Approve, decline (Rejected) or cancel.
 *
 * Authorization: leave.approve or leave.manage at the route. Inline:
 *   - approving / declining needs canDecideLeaveFor — never your own leave;
 *   - only a request still waiting can be approved or declined;
 *   - cancelling APPROVED leave needs leave.manage; cancelling a request still
 *     waiting is allowed to the applicant or anyone who could decide it.
 */
const decide = async (req, res) => {
  const { status, decisionNote } = req.body;
  const staffUser = req.staffUser;

  try {
    const leave = await StaffLeave.findOne({ where: { id: req.params.id, UserId: staffUser.id } });
    if (!leave) return error(res, 'Leave record not found', 404);

    const wasTaken = TAKEN_STATUSES.includes(leave.status);
    const isOpen = OPEN_STATUSES.includes(leave.status);
    const isOwn = req.user.id === staffUser.id;

    if (status === STATUS.CANCELLED) {
      if (!isOpen && !wasTaken) return error(res, `This leave is already ${leave.status.toLowerCase()}`, 400);
      if (wasTaken && !canManageLeave(req.user)) return error(res, 'Only someone who manages leave can cancel approved leave', 403);
      if (isOpen && !isOwn && !canDecideLeaveFor(req.user, staffUser)) return error(res, 'You cannot cancel this request', 403);
    } else {
      if (!canDecideLeaveFor(req.user, staffUser)) {
        return error(res, isOwn ? 'You cannot approve or decline your own leave' : 'You cannot decide this leave', 403);
      }
      if (!isOpen) return error(res, `This leave is already ${leave.status.toLowerCase()}`, 400);
    }

    await sequelize.transaction(async (t) => {
      await leave.update({
        status,
        decisionNote: decisionNote || null,
        approvedById: status === STATUS.APPROVED ? req.user.id : leave.approvedById,
        approvedAt:   status === STATUS.APPROVED ? new Date() : leave.approvedAt,
        updatedBy:    req.user.id,
      }, { transaction: t });

      if (status === STATUS.CANCELLED || status === STATUS.REJECTED) {
        await leaveService.releaseCharges(leave.id, t);
      }
      const eventType = { Approved: 'approved', Rejected: 'declined', Cancelled: 'cancelled' }[status];
      await leaveService.recordEvent(leave.id, req.user.id, eventType, { note: decisionNote || null }, t);
    });

    if (status === STATUS.APPROVED) {
      await applyApprovalSideEffects(leave, staffUser, req.user);
    } else if (wasTaken) {
      await removeApprovalSideEffects(leave, staffUser);
    }

    await leave.reload({ include: withDetail() });
    return success(res, formatLeave(leave));
  } catch (err) {
    console.error('StaffLeave.decide error:', err);
    return error(res, 'Failed to update leave', 500);
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
  create,
  decide,
  setBalances,
  applyApprovalSideEffects,
  removeApprovalSideEffects,
  LEAVE_TYPES,
  canDecideLeaveFor,
  canManageLeave,
  formatLeave,
};
