const db = require('../models');

const { UserLoginLog } = db;

// Roles whose logins are tracked in the activity log
const TRACKED_ROLES = new Set(['staff', 'doctor', 'lab']);

/**
 * Records a login event for staff, doctor, and lab users.
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
