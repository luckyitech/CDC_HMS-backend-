const db = require('../models');

const { UserLoginLog } = db;

// Roles whose logins are tracked in the activity log.
//
// Nurse and admin were missing, so neither appeared in the activity log or on
// the Activity tab of their staff file — it looked like they had never logged
// in. Patients are still excluded: they are not staff, and their portal is a
// different trust boundary.
//
// Must stay in step with the role ENUM on UserLoginLog. A role listed here but
// absent from the enum is silently dropped, because the insert below is
// fire-and-forget.
const TRACKED_ROLES = new Set(['staff', 'doctor', 'lab', 'nurse', 'admin']);

/**
 * Records a login event for staff accounts.
 * Fire-and-forget — never throws, never blocks the auth response.
 *
 * @param {object} user        - Sequelize User instance (must have id, firstName, lastName, role)
 * @param {string} ipAddress   - Client IP (may be null)
 */
const logLogin = (user, ipAddress) => {
  if (!TRACKED_ROLES.has(user.role)) return;

  UserLoginLog.create({
    userId:    user.id,
    name:      `${user.firstName} ${user.lastName}`,
    role:      user.role,
    ipAddress: ipAddress || null,
    loginAt:   new Date(),
  }).catch(() => {});
};

module.exports = { logLogin };
