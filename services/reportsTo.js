// "Reports to" — the DB half of utils/reportsTo (5 Oct 2026, HR fixes #1).
// One loader for both writers: staffController.update (the staff file) and
// userController.createStaffAccount (onboarding).

const db = require('../models');
const { normaliseReportsTo, reportsToProblem, namingYourselfProblem } = require('../utils/reportsTo');
const { PERMISSIONS, isTrueAdmin, passesAdminGate } = require('../constants/permissions');

class ReportsToError extends Error {
  constructor(message, code) { super(message); this.code = code; this.status = 400; }
}

/**
 * Validates a raw reportsToId for personId (null when the person is being
 * created), set by `caller`. Returns the value to store (a user id, or null to
 * clear); throws ReportsToError when refused.
 */
const resolveReportsTo = async (personId, raw, caller = null) => {
  const managerId = normaliseReportsTo(raw);
  const selfProblem = namingYourselfProblem({
    callerId: caller?.id,
    managerId,
    callerMayNameSelf: !!caller && (isTrueAdmin(caller) || passesAdminGate(caller, PERMISSIONS.HR_APPRAISALS_RUN)),
  });
  if (selfProblem) throw new ReportsToError(selfProblem.message, selfProblem.code);
  let manager = null;
  let managerOf = new Map();
  if (managerId) {
    const u = await db.User.findByPk(managerId, {
      attributes: ['id', 'role', 'isActive'],
      include: [{ model: db.StaffProfile, attributes: ['deletedAt'], required: false }],
    });
    if (u) manager = { id: u.id, role: u.role, isActive: u.isActive, archived: !!u.StaffProfile?.deletedAt };
    if (personId) {
      const rows = await db.StaffProfile.findAll({ attributes: ['UserId', 'reportsToId'], raw: true });
      managerOf = new Map(rows.filter((r) => r.reportsToId).map((r) => [Number(r.UserId), Number(r.reportsToId)]));
    }
  }
  const problem = reportsToProblem({ personId, managerId, manager, managerOf });
  if (problem) throw new ReportsToError(problem.message, problem.code);
  return managerId;
};

/** { id, name, employeeId } for display, or null. */
const reportsToSummary = async (reportsToId) => {
  if (!reportsToId) return null;
  const u = await db.User.findByPk(reportsToId, {
    attributes: ['id', 'firstName', 'lastName'],
    include: [{ model: db.StaffProfile, attributes: ['employeeId'], required: false }],
  });
  if (!u) return null;
  return { id: u.id, name: `${u.firstName} ${u.lastName}`, employeeId: u.StaffProfile?.employeeId || null };
};

module.exports = { resolveReportsTo, reportsToSummary, ReportsToError };
