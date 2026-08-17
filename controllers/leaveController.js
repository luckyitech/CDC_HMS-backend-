// Staff leave — requests, approval, and the yearly entitlement balance.
//
// findStaff has already resolved :employeeId onto req.staffProfile and
// req.staffUser before any of these run. See STAFF_PROFILE_DESIGN.md.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { countLeaveDays, datesInRange, rangesOverlap } = require('../utils/leaveDays');
const db = require('../models');
const sequelize = require('../config/database');

const { StaffLeave, LeaveBalance, StaffProfile, DoctorBlock, User } = db;

const LEAVE_TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];

// Blocking a whole day rather than individual slots. DoctorBlock already
// supports 'ALL_DAY' and the booking screens understand it.
const ALL_DAY = 'ALL_DAY';

// Only these count against entitlement, and only these are shown as "taken".
const COUNTS_AS_TAKEN = new Set(['Approved']);

const formatLeave = (leave) => ({
  id:          leave.id,
  leaveType:   leave.leaveType,
  startDate:   leave.startDate,
  endDate:     leave.endDate,
  days:        leave.days,
  reason:      leave.reason,
  status:      leave.status,
  approvedAt:  leave.approvedAt,
  approvedBy:  leave.approvedBy ? `${leave.approvedBy.firstName} ${leave.approvedBy.lastName}` : null,
  decisionNote: leave.decisionNote,
  blocksAppointments: Array.isArray(leave.doctorBlockIds) && leave.doctorBlockIds.length > 0,
  createdAt:   leave.createdAt,
});

/**
 * GET /api/staff/:employeeId/leaves?year=2026
 * Balance for the year plus the full history.
 *
 * Authorization: Admin, or the staff member themselves
 */
const list = async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const userId = req.staffUser.id;

  try {
    const [leaves, balances] = await Promise.all([
      StaffLeave.findAll({
        where: {
          UserId: userId,
          startDate: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] },
        },
        include: [{ model: User, as: 'approvedBy', attributes: ['firstName', 'lastName'] }],
        order: [['startDate', 'DESC']],
      }),
      LeaveBalance.findAll({ where: { UserId: userId, year } }),
    ]);

    // `taken` is summed from the leave rows rather than stored on the balance:
    // the rows are the record of what happened, and a cached total is only ever
    // a summary of them that can drift.
    const takenByType = {};
    leaves.forEach((l) => {
      if (!COUNTS_AS_TAKEN.has(l.status)) return;
      takenByType[l.leaveType] = (takenByType[l.leaveType] || 0) + l.days;
    });

    const byType = new Map(balances.map((b) => [b.leaveType, b]));

    const summary = LEAVE_TYPES.map((leaveType) => {
      const balance     = byType.get(leaveType);
      const entitled    = balance ? balance.entitled : 0;
      const carriedOver = balance ? balance.carriedOver : 0;
      const taken       = takenByType[leaveType] || 0;

      return {
        leaveType,
        entitled,
        carriedOver,
        taken,
        // Can go negative — an admin may approve leave beyond entitlement, and
        // hiding that behind a floor of zero would misreport the position.
        remaining: entitled + carriedOver - taken,
      };
    });

    return success(res, {
      year,
      summary,
      leaves: leaves.map(formatLeave),
    });
  } catch (err) {
    console.error('List leave error:', err.message);
    return error(res, 'Failed to load leave', 500);
  }
};

/**
 * POST /api/staff/:employeeId/leaves
 * Records leave. An admin's entry is approved immediately; a staff member
 * requesting their own leave creates a pending request.
 *
 * Authorization: Admin, or the staff member themselves
 */
const create = async (req, res) => {
  const { leaveType, startDate, endDate, reason, excludeWeekends } = req.body;
  const user = req.staffUser;

  const days = countLeaveDays(startDate, endDate, { excludeWeekends: !!excludeWeekends });
  if (days <= 0) return error(res, 'End date must be on or after the start date', 400);

  try {
    // Two overlapping approved requests would double-count against the balance
    // and, for a doctor, produce duplicate blocks on the same day.
    const nearby = await StaffLeave.findAll({
      where: {
        UserId: user.id,
        status: { [Op.in]: ['Pending', 'Approved'] },
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

    const isAdmin = req.user.role === 'admin';

    const leave = await StaffLeave.create({
      UserId:    user.id,
      leaveType,
      startDate,
      endDate,
      days,
      reason:    reason || null,
      status:    isAdmin ? 'Approved' : 'Pending',
      approvedById: isAdmin ? req.user.id : null,
      approvedAt:   isAdmin ? new Date() : null,
      createdBy: req.user.id,
    });

    if (isAdmin) await applyApprovalSideEffects(leave, user, req.user);

    await leave.reload({ include: [{ model: User, as: 'approvedBy', attributes: ['firstName', 'lastName'] }] });
    return success(res, formatLeave(leave), 201);
  } catch (err) {
    console.error('Create leave error:', err.message);
    return error(res, 'Failed to record leave', 500);
  }
};

/**
 * Everything that follows from approving leave, kept in one place so approving
 * on creation and approving later behave identically.
 *
 * For a doctor this writes one all-day DoctorBlock per date, so reception
 * cannot book someone who is away — without it, the leave is recorded and the
 * appointment book carries on as if they were in.
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
          reason: `${leave.leaveType} leave`,
        },
      });
      blockIds.push(block.id);
    }

    await leave.update({ doctorBlockIds: blockIds });
  }

  // Reflected on the profile so the header pill tells the truth today. Login is
  // deliberately NOT disabled — someone on annual leave should still be able to
  // sign in; suspension is what blocks access.
  const today = new Date().toISOString().slice(0, 10);
  if (leave.startDate <= today && leave.endDate >= today) {
    await StaffProfile.update(
      { employmentStatus: 'On Leave' },
      { where: { UserId: staffUser.id } }
    );
  }
};

/**
 * PATCH /api/staff/:employeeId/leaves/:id
 * Approve, reject or cancel.
 *
 * Authorization: Admin only
 */
const decide = async (req, res) => {
  const { status, decisionNote } = req.body;
  const staffUser = req.staffUser;

  try {
    const leave = await StaffLeave.findOne({ where: { id: req.params.id, UserId: staffUser.id } });
    if (!leave) return error(res, 'Leave record not found', 404);

    if (leave.status === status) return error(res, `This leave is already ${status.toLowerCase()}`, 400);

    const wasApproved = leave.status === 'Approved';

    await leave.update({
      status,
      decisionNote: decisionNote || null,
      approvedById: status === 'Approved' ? req.user.id : leave.approvedById,
      approvedAt:   status === 'Approved' ? new Date() : leave.approvedAt,
      updatedBy:    req.user.id,
    });

    if (status === 'Approved') {
      await applyApprovalSideEffects(leave, staffUser, req.user);
    } else if (wasApproved) {
      await removeApprovalSideEffects(leave, staffUser);
    }

    await leave.reload({ include: [{ model: User, as: 'approvedBy', attributes: ['firstName', 'lastName'] }] });
    return success(res, formatLeave(leave));
  } catch (err) {
    console.error('Decide leave error:', err.message);
    return error(res, 'Failed to update leave', 500);
  }
};

/**
 * Undoes approval. Only the blocks this leave created are removed — matching by
 * date instead would also delete blocks the doctor set for their own reasons.
 */
const removeApprovalSideEffects = async (leave, staffUser) => {
  const ids = Array.isArray(leave.doctorBlockIds) ? leave.doctorBlockIds : [];

  if (ids.length) {
    await DoctorBlock.destroy({ where: { id: { [Op.in]: ids } } });
    await leave.update({ doctorBlockIds: null });
  }

  // Only step the profile back out of 'On Leave' if no other approved leave
  // covers today, or cancelling one of two overlapping absences would mark
  // someone present while they are still away.
  const today = new Date().toISOString().slice(0, 10);
  const stillOnLeave = await StaffLeave.count({
    where: {
      UserId: staffUser.id,
      status: 'Approved',
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
 * Sets entitlement for a year. Accepts a list so a whole year is configured in
 * one call rather than one request per leave type.
 *
 * Authorization: Admin only
 */
const setBalances = async (req, res) => {
  const { year, balances } = req.body;
  const userId = req.staffUser.id;

  let transaction;
  try {
    transaction = await sequelize.transaction();

    for (const entry of balances) {
      const [row, created] = await LeaveBalance.findOrCreate({
        where: { UserId: userId, year, leaveType: entry.leaveType },
        defaults: {
          entitled:    entry.entitled || 0,
          carriedOver: entry.carriedOver || 0,
          createdBy:   req.user.id,
        },
        transaction,
      });

      if (!created) {
        await row.update({
          entitled:    entry.entitled ?? row.entitled,
          carriedOver: entry.carriedOver ?? row.carriedOver,
          updatedBy:   req.user.id,
        }, { transaction });
      }
    }

    await transaction.commit();

    const saved = await LeaveBalance.findAll({ where: { UserId: userId, year } });
    return success(res, saved);
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Set leave balances error:', err.message);
    return error(res, 'Failed to save leave entitlement', 500);
  }
};

module.exports = { list, create, decide, setBalances, LEAVE_TYPES };
