// HR Suite (B21) — check-in phones. A person sees and removes their own;
// HR (hr.tags — was hr.write — or hr.devices.register) can list and revoke
// anyone's from the dashboard or staff file. Since 17 Oct 2026 only
// hr.devices.register holders register one (issueRegistration below).
const db = require('../models');
const { success, error } = require('../utils/response');
const { canManageCheckinDevices } = require('../utils/hrAccess');
const { INTERNAL_ROLES } = require('../constants/permissions');
const checkinPhones = require('../services/checkinPhones');

const { UserDevice, User } = db;

const serialize = (d) => ({
  id: d.id, label: d.label, lastSeenAt: d.lastSeenAt, lastIp: d.lastIp,
  createdAt: d.createdAt, expiresAt: d.expiresAt, revokedAt: d.revokedAt, UserId: d.UserId,
  // null = remembered by the person themselves, before HR registered phones.
  registeredBy: d.registeredBy ? `${d.registeredBy.firstName} ${d.registeredBy.lastName}` : null,
});

/** GET /api/hr/devices/me?userId= — own phones, or (hr.tags) another person's. */
const list = async (req, res) => {
  try {
    let userId = req.user.id;
    if (req.query.userId && parseInt(req.query.userId, 10) !== req.user.id) {
      if (!canManageCheckinDevices(req.user)) return error(res, 'You do not have permission to do that.', 403);
      userId = parseInt(req.query.userId, 10);
    }
    const rows = await UserDevice.findAll({
      where: { UserId: userId, revokedAt: null },
      include: [{ model: User, as: 'registeredBy', attributes: ['firstName', 'lastName'] }],
      order: [['lastSeenAt', 'DESC']],
    });
    return success(res, rows.map(serialize));
  } catch (err) {
    console.error('UserDevice.list error:', err);
    return error(res, 'Failed to load remembered phones', 500);
  }
};

/** DELETE /api/hr/devices/:id — revoke. Own device for anyone; others' for hr.tags. */
const revoke = async (req, res) => {
  try {
    const d = await UserDevice.findByPk(req.params.id);
    if (!d || d.revokedAt) return error(res, 'Phone not found', 404);
    if (d.UserId !== req.user.id && !canManageCheckinDevices(req.user)) return error(res, 'You do not have permission to do that.', 403);
    await d.update({ revokedAt: new Date(), revokedById: req.user.id });
    return success(res, { id: d.id, revoked: true });
  } catch (err) {
    console.error('UserDevice.revoke error:', err);
    return error(res, 'Failed to remove the phone', 500);
  }
};

/**
 * POST /api/hr/devices/registration { userId } — hr.devices.register (the
 * route checks it). A one-time code for that person's phone: 8 characters,
 * 10 minutes, works once; a newer code ends the older. Shown to HR once.
 */
const issueRegistration = async (req, res) => {
  try {
    const target = await User.findByPk(req.body.userId, { attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'] });
    if (!target || !INTERNAL_ROLES.includes(target.role)) return error(res, 'Staff member not found', 404);
    if (!target.isActive) return error(res, 'This account is not active, so it cannot check in.', 409);
    const { code, expiresAt } = await checkinPhones.issueRegistration({ target, issuer: req.user });
    return success(res, { code, expiresAt, minutes: checkinPhones.CODE_MINUTES, name: `${target.firstName} ${target.lastName}` });
  } catch (err) {
    console.error('PhoneRegistration.issue error:', err);
    return error(res, 'Could not create a registration code', 500);
  }
};

module.exports = { list, revoke, issueRegistration };
