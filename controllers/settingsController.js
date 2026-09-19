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

// =====================================================================
// Lab Inbox — mailbox connection + import policy (System Settings → Lab Inbox)
// =====================================================================
const {
  getLabInboxConfig,
  setLabInboxConfig,
  AFTER_IMPORT,
} = require('../utils/labInboxConfig');

/**
 * GET /api/settings/lab-inbox
 * The connection + policy WITHOUT the password (only `hasPassword`), plus the
 * last poll result for the status line.
 * Authorization: admin / config.write
 */
const getLabInbox = async (req, res) => {
  try {
    return success(res, await getLabInboxConfig({ redact: true }));
  } catch (err) {
    console.error('getLabInbox error:', err.message);
    return error(res, 'Failed to load the Lab Inbox settings', 500);
  }
};

/**
 * PUT /api/settings/lab-inbox
 * Any subset of: host, port, secure, user, password, mailbox, enabled,
 * pollIntervalMin, afterImport, moveFolder, allowlist[].
 * A blank password leaves the stored one unchanged. Nothing ships pre-filled.
 * Authorization: a real admin account (credentials) — see routes/settings.js
 */
const updateLabInbox = async (req, res) => {
  try {
    const allowed = ['host', 'port', 'secure', 'user', 'password', 'mailbox', 'enabled',
      'pollIntervalMin', 'afterImport', 'moveFolder', 'allowlist'];
    const changes = {};
    for (const k of allowed) if (req.body[k] !== undefined) changes[k] = req.body[k];
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);

    if (changes.afterImport !== undefined && !AFTER_IMPORT.includes(changes.afterImport)) {
      return error(res, `afterImport must be one of ${AFTER_IMPORT.join(', ')}`, 400);
    }
    if (changes.user !== undefined && changes.user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.user)) {
      return error(res, 'The mailbox must be a valid email address.', 400);
    }

    const cfg = await setLabInboxConfig(changes);
    return success(res, cfg);
  } catch (err) {
    console.error('updateLabInbox error:', err.message);
    // Validation errors from the config layer are user-facing.
    const userFacing = /must be|not a valid|required|between/i.test(err.message || '');
    return error(res, userFacing ? err.message : 'Failed to update the Lab Inbox settings', userFacing ? 400 : 500);
  }
};

/**
 * POST /api/settings/lab-inbox/test
 * Tries the connection with the submitted (possibly unsaved) values; the
 * stored password is used when none is sent. Never persists anything.
 * Authorization: admin / config.write
 */
const testLabInbox = async (req, res) => {
  try {
    const { testConnection } = require('../services/labInboxPoller');
    const result = await testConnection(req.body || {});
    return success(res, result);
  } catch (err) {
    console.error('testLabInbox error:', err.message);
    return error(res, `Connection failed: ${err.message}`, 400);
  }
};

module.exports = {
  getPasswordRotation,
  updatePasswordRotation,
  getLabInbox,
  updateLabInbox,
  testLabInbox,
};
