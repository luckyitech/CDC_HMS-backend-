const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const {
  ROTATING_ROLES,
  ROTATION_DAY_NAME,
  INTERVALS,
  isValidInterval,
  getRotationConfig,
  setRotationConfig,
  currentPeriodStart,
  nextRotationDate,
} = require('../utils/passwordRotation');
const { clinicMidnight } = require('../utils/clinicTime');
const db = require('../models');

const { User } = db;

// Shared shape for both the read and the write, so the admin page always gets
// the recomputed schedule back after changing something.
const buildRotationPayload = async () => {
  const { enabled, interval } = await getRotationConfig();
  const periodStart = currentPeriodStart(interval);

  // Same predicate as isPasswordExpired, expressed in SQL: never set, or set
  // before the current period opened.
  const where = { role: ROTATING_ROLES, isActive: true };
  const [dueCount, totalStaff] = await Promise.all([
    User.count({
      where: {
        ...where,
        [Op.or]: [
          { passwordChangedAt: null },
          { passwordChangedAt: { [Op.lt]: clinicMidnight(periodStart) } },
        ],
      },
    }),
    User.count({ where }),
  ]);

  return {
    enabled,
    interval,
    intervalLabel: INTERVALS[interval].label,
    intervalOptions: Object.values(INTERVALS),
    rotationDay: ROTATION_DAY_NAME,
    affectedRoles: ROTATING_ROLES,
    periodStart,
    nextRotation: nextRotationDate(interval),
    dueCount,
    totalStaff,
  };
};

/**
 * GET /api/settings/password-rotation
 * Current state of scheduled staff password rotation, plus a count of who is
 * currently due — so the admin can see the blast radius before turning it on.
 * Authorization: admin
 */
const getPasswordRotation = async (req, res) => {
  try {
    return success(res, await buildRotationPayload());
  } catch (err) {
    console.error('getPasswordRotation error:', err.message);
    return error(res, 'Failed to load the password rotation setting', 500);
  }
};

/**
 * PUT /api/settings/password-rotation
 * Body may carry either or both of:
 *   enabled  — boolean
 *   interval — 'weekly' | 'fortnightly' | 'monthly'
 * Authorization: admin
 */
const updatePasswordRotation = async (req, res) => {
  try {
    const { enabled, interval } = req.body;

    if (enabled === undefined && interval === undefined) {
      return error(res, "Provide 'enabled' and/or 'interval'", 400);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return error(res, "'enabled' must be true or false", 400);
    }
    if (interval !== undefined && !isValidInterval(interval)) {
      return error(
        res,
        `Invalid interval '${interval}'. Valid intervals: ${Object.keys(INTERVALS).join(', ')}`,
        400
      );
    }

    await setRotationConfig({ enabled, interval });
    return success(res, await buildRotationPayload());
  } catch (err) {
    console.error('updatePasswordRotation error:', err.message);
    return error(res, 'Failed to update the password rotation setting', 500);
  }
};

module.exports = { getPasswordRotation, updatePasswordRotation };
