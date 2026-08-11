const { success, error } = require('../utils/response');
const {
  ROTATING_ROLES,
  MINIMUM_PASSWORD_AGE_DAYS,
  INTERVALS,
  isValidInterval,
  getRotationConfig,
  setRotationConfig,
  expiredWhere,
  dueSoonWhere,
} = require('../utils/passwordRotation');
const { notifyStaffOfRotationPolicy } = require('../services/passwordRotationNotifier');
const db = require('../models');

const { User } = db;

// Shared shape for both the read and the write, so the admin page always gets
// the recomputed numbers back after changing something.
const buildRotationPayload = async () => {
  const { enabled, interval } = await getRotationConfig();

  const activeStaff = { role: ROTATING_ROLES, isActive: true };

  // Both predicates come from utils/passwordRotation so the counts shown here
  // can never disagree with what the login gate actually enforces.
  const [dueCount, dueSoonCount, totalStaff] = await Promise.all([
    User.count({ where: { ...activeStaff, ...expiredWhere(interval) } }),
    User.count({ where: { ...activeStaff, ...dueSoonWhere(interval) } }),
    User.count({ where: activeStaff }),
  ]);

  return {
    enabled,
    interval,
    intervalLabel: INTERVALS[interval].label,
    intervalOptions: Object.values(INTERVALS).map(({ value, label, description, duration }) => ({
      value, label, description, duration,
    })),
    affectedRoles: ROTATING_ROLES,
    minimumPasswordAgeDays: MINIMUM_PASSWORD_AGE_DAYS,
    dueCount,
    dueSoonCount,
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
 * Authorization: a real admin account (see routes/settings.js)
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

    const wasEnabled = (await getRotationConfig()).enabled;
    const config = await setRotationConfig({ enabled, interval });

    // Announce the policy the moment it is switched on, so staff hear it from
    // their inbox rather than from being locked out mid-shift. Only on the
    // off -> on transition: re-saving an interval while it is already running
    // would otherwise mail the whole clinic every time the admin nudges a button.
    //
    // Not awaited. The admin's response must not wait on one SMTP round trip per
    // member of staff, and a mail outage must never stop the policy taking
    // effect — the login gate enforces it, not the email.
    if (!wasEnabled && config.enabled) {
      notifyStaffOfRotationPolicy(config.interval)
        .catch((err) => console.warn('[Settings] rotation notice failed:', err.message));
    }

    return success(res, await buildRotationPayload());
  } catch (err) {
    console.error('updatePasswordRotation error:', err.message);
    return error(res, 'Failed to update the password rotation setting', 500);
  }
};

module.exports = { getPasswordRotation, updatePasswordRotation };
