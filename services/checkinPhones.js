// Check-in phones (HR Suite B21; registered by HR since 17 Oct 2026, Emu).
//
// Emu: "only HR with the register phones permission can register a phone",
// and a phone registered for check-in must not be a way into the HMS.
//
//   1. HR (hr.devices.register) issues a one-time code for a person:
//      8 characters, works once, for 10 minutes. A newer code ends the older.
//   2. The person enters it on their own phone at the tap page. The phone
//      receives a long random token (only its SHA-256 is stored) and becomes
//      their ONE check-in phone — any earlier phone is revoked.
//   3. The person and HR are told (hrNotify 'phone_registered').
//
// The token itself buys only a check-in-only pass (authController.deviceSession,
// scope 'tap'); signing in to the HMS still needs the password.

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const { getHrConfig } = require('../utils/hrConfig');
const { clientIp } = require('../utils/ip');
const { deviceLabel } = require('../utils/deviceLabel');
const { canManageCheckinDevices } = require('../utils/hrAccess');
const { INTERNAL_ROLES } = require('../constants/permissions');
const { notify, holdersOf } = require('./hrNotify');

const { sequelize, User, UserDevice, PhoneRegistration, StaffProfile } = db;

const CODE_MINUTES = 10;
const CODE_LENGTH = 8;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1 — read aloud and typed on a phone
const INVALID_CODE = 'That code is not valid or has expired. Ask HR for a new one.';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim();
const normaliseCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = () => Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

/** A new device token for `user`. Returns the raw token (shown to the phone once) and the row. */
const createDevice = async (user, req, { registeredById = null, transaction } = {}) => {
  const cfg = await getHrConfig();
  const raw = crypto.randomBytes(32).toString('base64url');
  const device = await UserDevice.create({
    UserId: user.id, tokenHash: sha256(raw), label: deviceLabel(req.headers['user-agent'], 'Phone'),
    lastSeenAt: new Date(), lastIp: clientIp(req), registeredById,
    expiresAt: new Date(Date.now() + cfg.deviceDays * 24 * 60 * 60 * 1000),
  }, { transaction });
  return { raw, device };
};

/** HR issues a code for `target`. Any earlier unused code for them stops working. */
const issueRegistration = async ({ target, issuer }) => {
  const now = new Date();
  await PhoneRegistration.update(
    { expiresAt: now },
    { where: { UserId: target.id, usedAt: null, expiresAt: { [Op.gt]: now } } },
  );
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_MINUTES * 60 * 1000);
  await PhoneRegistration.create({ UserId: target.id, codeHash: sha256(code), expiresAt, issuedById: issuer.id });
  return { code, expiresAt };
};

/** Tell the person and whoever looks after check-in phones. Best-effort, never throws. */
const announce = async ({ user, device, issuedById, replaced }) => {
  try {
    const issuer = issuedById ? await User.findByPk(issuedById, { attributes: ['firstName', 'lastName'] }) : null;
    const by = issuer ? fullName(issuer) : 'HR';
    await notify('phone_registered', {
      recipients: [user.id],
      title: 'A phone was registered for your check-in',
      body: `${device.label}, registered by ${by}.${replaced ? ' Your previous phone no longer checks you in.' : ''} `
        + 'If this was not you, tell HR straight away.',
      link: '/hr/me', actorName: by,
    });
    const hr = (await holdersOf(canManageCheckinDevices)).filter((id) => id !== user.id);
    const profile = await StaffProfile.findOne({ where: { UserId: user.id }, attributes: ['employeeId'] });
    await notify('phone_registered', {
      recipients: hr,
      title: `Check-in phone registered — ${fullName(user)}`,
      body: `${device.label}, registered by ${by}.${replaced ? ' It replaces their previous phone.' : ''}`,
      link: profile?.employeeId ? `/hr/staff/${profile.employeeId}` : null, actorName: by,
    });
  } catch (err) {
    console.error('checkinPhones.announce error:', err);
  }
};

/**
 * The phone enters the code. Returns { deviceToken, user } or { error }.
 * The claim is atomic, so a code raced from two phones registers one.
 */
const redeemRegistration = async (rawCode, req) => {
  const code = normaliseCode(rawCode);
  if (code.length !== CODE_LENGTH || [...code].some((ch) => !ALPHABET.includes(ch))) return { error: INVALID_CODE };
  const now = new Date();
  const reg = await PhoneRegistration.findOne({ where: { codeHash: sha256(code), usedAt: null, expiresAt: { [Op.gt]: now } } });
  if (!reg) return { error: INVALID_CODE };
  const user = await User.findByPk(reg.UserId);
  if (!user || !user.isActive || !INTERNAL_ROLES.includes(user.role)) return { error: INVALID_CODE };

  const done = await sequelize.transaction(async (transaction) => {
    // One person's registrations happen one at a time, so two codes redeemed
    // at the same moment still leave a single phone.
    await User.findByPk(user.id, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    const [claimed] = await PhoneRegistration.update({ usedAt: now }, { where: { id: reg.id, usedAt: null }, transaction });
    if (!claimed) return null;
    // One phone per person: whatever checked them in before stops now.
    const [replaced] = await UserDevice.update(
      { revokedAt: now, revokedById: reg.issuedById },
      { where: { UserId: user.id, revokedAt: null }, transaction },
    );
    const { raw, device } = await createDevice(user, req, { registeredById: reg.issuedById, transaction });
    await PhoneRegistration.update({ deviceId: device.id }, { where: { id: reg.id }, transaction });
    return { raw, device, replaced };
  });
  if (!done) return { error: INVALID_CODE };

  await announce({ user, device: done.device, issuedById: reg.issuedById, replaced: done.replaced > 0 });
  return { deviceToken: done.raw, user };
};

module.exports = { issueRegistration, redeemRegistration, CODE_MINUTES };
