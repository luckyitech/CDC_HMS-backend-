// HR Suite (B21) — remembered phones. A person sees and removes their own;
// HR (hr.write) can list and revoke anyone's from the dashboard or staff file.
const db = require('../models');
const { success, error } = require('../utils/response');
const { canWriteHr } = require('../utils/hrAccess');

const { UserDevice } = db;

const serialize = (d) => ({
  id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, lastIp: d.lastIp,
  createdAt: d.createdAt, expiresAt: d.expiresAt, revokedAt: d.revokedAt, UserId: d.UserId,
});

/** GET /api/hr/devices/me?userId= — own phones, or (hr.write) another person's. */
const list = async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.query.userId && parseInt(req.query.userId, 10) !== req.user.id) {
      if (!canWriteHr(req.user)) return error(res, 'You do not have permission to do that.', 403);
      userId = parseInt(req.query.userId, 10);
    }
    const rows = await UserDevice.findAll({ where: { UserId: userId, revokedAt: null }, order: [['lastSeenAt', 'DESC']] });
    return success(res, rows.map(serialize));
  } catch (err) {
    console.error('UserDevice.list error:', err);
    return error(res, 'Failed to load remembered phones', 500);
  }
};

/** DELETE /api/hr/devices/:id — revoke. Own device for anyone; others' for hr.write. */
const revoke = async (req, res) => {
  try {
    const d = await UserDevice.findByPk(req.params.id);
    if (!d || d.revokedAt) return error(res, 'Phone not found', 404);
    if (d.UserId !== req.user.id && !canWriteHr(req.user)) return error(res, 'You do not have permission to do that.', 403);
    await d.update({ revokedAt: new Date(), revokedById: req.user.id });
    return success(res, { id: d.id, revoked: true });
  } catch (err) {
    console.error('UserDevice.revoke error:', err);
    return error(res, 'Failed to remove the phone', 500);
  }
};

module.exports = { list, revoke };
