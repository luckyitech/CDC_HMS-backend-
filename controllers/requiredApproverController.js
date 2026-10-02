// Required approvers — HR Tier 2 (Emu, 2 Oct 2026, T2-3: leave.manage, per
// person, on the staff file). Whoever is listed here is added as an APPROVER
// to every NEW leave request this person makes, and they cannot remove them
// (hrSelfLeaveController.submit → leaveWorkflow.mergeRequired). Requests
// already sent are not changed.
//
//   GET /api/staff/:employeeId/required-approvers   the staff file's Leave tab
//                                                   (leaveViewOrSelf at the route)
//   PUT /api/staff/:employeeId/required-approvers   { approverIds: [] } — leave.manage,
//                                                   never on your own file (OWN_FILE)
//
// Every change is a UserEditLog row on the person's file.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { PERMISSIONS, passesAdminGate, INTERNAL_ROLES } = require('../constants/permissions');
const { writeUserEditLog } = require('../services/hrAttendanceService');
const sequelize = require('../config/database');
const db = require('../models');

const { StaffRequiredApprover, User, StaffProfile } = db;

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);
const MAX = 5;

const listFor = async (userId) => {
  const rows = await StaffRequiredApprover.findAll({
    where: { UserId: userId },
    include: [{
      model: User, as: 'approver',
      attributes: ['id', 'firstName', 'lastName', 'role', 'isActive', 'permissions', 'deniedPermissions', 'staffType'],
      include: [{ model: StaffProfile, attributes: ['position', 'deletedAt'], required: false }],
    }],
    order: [['id', 'ASC']],
  });
  return rows.filter((r) => r.approver).map((r) => ({
    userId: r.approver.id,
    name: fullName(r.approver),
    position: r.approver.StaffProfile?.position || null,
    role: r.approver.role,
    active: !!r.approver.isActive && !r.approver.StaffProfile?.deletedAt,
    canApprove: passesAdminGate(r.approver, PERMISSIONS.LEAVE_APPROVE),
  }));
};

/** Active required approver ids for a person — what submit forces in. */
const activeRequiredIds = async (userId) => (await listFor(userId)).filter((r) => r.active).map((r) => r.userId);

const list = async (req, res) => {
  try {
    return success(res, { approvers: await listFor(req.staffUser.id), canEdit: passesAdminGate(req.user, PERMISSIONS.LEAVE_MANAGE) && req.staffUser.id !== req.user.id });
  } catch (err) {
    console.error('RequiredApprover.list error:', err);
    return error(res, 'Failed to load required approvers', 500);
  }
};

const set = async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.approverIds) ? req.body.approverIds : []).map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return error(res, 'One of those people could not be found.', 400, { code: 'BAD_USER' });
  if (ids.length > MAX) return error(res, `At most ${MAX} required approvers.`, 400, { code: 'TOO_MANY' });
  const person = req.staffUser;
  if (person.id === req.user.id) return error(res, 'Someone else sets the required approvers on your own file.', 403, { code: 'OWN_FILE' });
  if (ids.includes(person.id)) return error(res, 'A person cannot approve their own leave.', 400, { code: 'SELF' });

  try {
    const people = ids.length ? await User.findAll({
      where: { id: { [Op.in]: ids }, isActive: true, role: { [Op.in]: INTERNAL_ROLES } },
      attributes: ['id', 'firstName', 'lastName'],
      include: [{ model: StaffProfile, attributes: ['deletedAt'], required: false }],
    }) : [];
    const ok = people.filter((u) => !u.StaffProfile || !u.StaffProfile.deletedAt);
    if (ok.length !== ids.length) return error(res, 'One of the people you chose is no longer active.', 400, { code: 'INACTIVE' });

    const before = await listFor(person.id);
    const actor = await User.findByPk(req.user.id, { attributes: ['id', 'firstName', 'lastName'] });
    await sequelize.transaction(async (t) => {
      await StaffRequiredApprover.destroy({ where: { UserId: person.id, approverId: { [Op.notIn]: ids.length ? ids : [0] } }, transaction: t });
      const have = new Set(before.map((b) => b.userId));
      const add = ids.filter((id) => !have.has(id));
      if (add.length) {
        await StaffRequiredApprover.bulkCreate(add.map((id) => ({ UserId: person.id, approverId: id, setById: req.user.id })), { transaction: t });
      }
      const names = (list) => list.map((p) => p.name).sort().join(', ') || '—';
      const afterNames = ok.map((u) => fullName(u)).sort().join(', ') || '—';
      if (names(before) !== afterNames) {
        await writeUserEditLog({ targetUserId: person.id, actor, changes: { requiredApprovers: { from: names(before), to: afterNames } }, transaction: t });
      }
    });
    return success(res, { approvers: await listFor(person.id), canEdit: true });
  } catch (err) {
    console.error('RequiredApprover.set error:', err);
    return error(res, 'Failed to save required approvers', 500);
  }
};

module.exports = { list, set, activeRequiredIds, listFor };
