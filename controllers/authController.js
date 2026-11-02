const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { sendPasswordResetEmail } = require('../utils/emailService');
const {
  PERMISSIONS, hasPermission, canOpenPortal, effectivePermissions, deniedPermissions, canUseStock,
} = require('../constants/permissions');
const { getRotationStatus } = require('../utils/passwordRotation');
const db = require('../models');

const { User, StaffProfile, Patient, UserDevice } = db;
const { recordSignin, attachGps } = require('../services/signinLog');
const { getSigninSecurityConfig } = require('../utils/signinSecurityConfig');
const { clientIp } = require('../utils/ip');
const { blockedByLock, LOCK_MESSAGE } = require('../utils/networkLock');
const { getHrConfig } = require('../utils/hrConfig');
const { redeemRegistration } = require('../services/checkinPhones');
const { STAFF_ROLES } = require('../constants/staffRoles');

// Every staff cadre shares one profile table now, so this is a membership test
// rather than a lookup map. Patients resolve to Patient, handled separately in
// buildUserResponse.
const hasStaffProfile = (role) => STAFF_ROLES.includes(role);


// ------------------------------------
// Helper: builds the user response object with role-specific profile data
// ------------------------------------
const buildUserResponse = async (user) => {
  const userData = {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.isActive ? 'Active' : 'Inactive',
    // Everything this account can do, resolved: a real admin holds every
    // permission implicitly, everyone else holds what was granted MINUS what
    // has been explicitly withdrawn. Resolving it here means the frontend never
    // has to reason about withdrawals — it receives the answer, not the inputs.
    // Drives which portals and sidebar entries appear; the API is still guarded
    // server-side, so this is UX, never the security boundary.
    permissions: [...effectivePermissions(user)],
    // Derived: may open the Stocks page at all — holds at least one Stocks tab
    // (per-tab permissions, 13 Oct 2026). The stored column is superseded;
    // nothing should read user.canManageStock directly any more.
    canManageStock: canUseStock(user),
    // Which portal shells this account may open, resolved here: their role's own
    // portal, plus anything granted, minus anything withdrawn. Sent as an answer
    // rather than as inputs so ProtectedRoute and the sidebar cannot each derive
    // a slightly different one.
    portals: Object.values(PERMISSIONS)
      .filter((p) => p.startsWith('portal.'))
      .filter((p) => canOpenPortal(user, p)),
    // What has been explicitly WITHDRAWN. `permissions` above is already
    // resolved, so most screens never need this — but a menu entry behind an
    // authorize('admin', <cap>) gate is reachable by admin.access alone, and the
    // frontend cannot tell "never granted, but admin.access covers it" from
    // "withdrawn, so admin.access must not cover it" without seeing this list.
    deniedPermissions: [...deniedPermissions(user)],
    // Clinical or non-clinical. `permissions` above already has the bundle
    // folded in, so no screen needs this to decide what to show — it is sent so
    // the Staff File can display and edit the classification, and so a screen
    // can explain WHY something is missing ("this account is non-clinical")
    // rather than only that it is.
    staffType: user.staffType,
  };

  // Scheduled password rotation. mustChangePassword sends the frontend straight
  // to the change-password screen and keeps it there; passwordExpiresOn is the
  // Monday the current password lapses and passwordPolicyLabel describes the
  // cadence ("every Monday", "every second Monday", …) so staff-facing copy can
  // name the real schedule. All hints — the middleware is what blocks the API.
  const rotation = await getRotationStatus(user);
  userData.mustChangePassword   = rotation.mustChangePassword;
  userData.passwordExpiresOn    = rotation.expiresOn;
  userData.passwordPolicyLabel  = rotation.policyLabel;

  if (hasStaffProfile(user.role)) {
    const profile = await StaffProfile.findOne({ where: { UserId: user.id } });
    if (profile) {
      // Audit and soft-delete bookkeeping is stripped along with the PKs —
      // it is internal, and this object is returned to the browser on login.
      const {
        id, UserId, createdAt, updatedAt,
        createdBy, updatedBy, deletedAt, deletedBy,
        ...fields
      } = profile.dataValues;
      Object.assign(userData, fields);
    }
  } else if (user.role === 'patient') {
    // patient — attach uhid and diagnosis from the Patient table
    const patient = await Patient.findOne({ where: { userId: user.id } });
    if (patient) {
      userData.uhid = patient.uhid;
      userData.diagnosis = patient.diagnosis;
    }
  }

  return userData;
};

// ------------------------------------
// Check-in phones (HR Suite, B21; registered by HR since 17 Oct 2026)
//
// The HMS session is per-tab sessionStorage, so a URL opened from the
// entrance NFC tag always lands logged out. A phone HR has registered
// (services/checkinPhones.js) keeps a long random token, and every tap
// exchanges it here for a CHECK-IN-ONLY pass — scope 'tap', 15 minutes,
// refused by middleware/auth.js everywhere but the tap itself. Emu: a phone
// registered for check-in must never be a way into the HMS; that needs the
// password. Only the token's SHA-256 is stored; it rolls forward `deviceDays`
// on every use and dies when the account is deactivated/archived, HR revokes
// it, or a newer phone is registered for the same person.
// ------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const signSession = (user, extra = {}, { expiresIn = process.env.JWT_EXPIRES_IN } = {}) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, name: `${user.firstName} ${user.lastName}`, ...extra },
  process.env.JWT_SECRET,
  { expiresIn }
);
const TAP_PASS_TTL = '15m';

// ------------------------------------
// POST /api/auth/device-session { deviceToken } → a check-in-only pass
// ------------------------------------
const deviceSession = async (req, res) => {
  try {
    const raw = String(req.body.deviceToken || '');
    if (raw.length < 32 || raw.length > 128) return error(res, 'This phone is no longer registered for check-in. Ask HR to register it.', 401);
    const device = await UserDevice.findOne({ where: { tokenHash: sha256(raw), revokedAt: null } });
    if (!device || new Date(device.expiresAt) < new Date()) return error(res, 'This phone is no longer registered for check-in. Ask HR to register it.', 401);
    const user = await User.findByPk(device.UserId);
    if (!user || !user.isActive || user.role === 'patient') return error(res, 'This phone is no longer registered for check-in. Ask HR to register it.', 401);

    // The network lock applies to remembered phones too, unless the clinic
    // exempts the entrance tag (Settings → Sign-in security).
    if (blockedByLock({ user, ip: clientIp(req), cfg: await getSigninSecurityConfig(), viaDevice: true })) {
      await recordSignin(req, { user, outcome: 'failed', failReason: 'outside_blocked', method: 'device' });
      return error(res, LOCK_MESSAGE, 423, { code: 'OUTSIDE_CLINIC' });
    }
    const cfg = await getHrConfig();
    await device.update({ lastSeenAt: new Date(), lastIp: clientIp(req), expiresAt: new Date(Date.now() + cfg.deviceDays * 24 * 60 * 60 * 1000) });
    const signin = await recordSignin(req, { user, method: 'device' });
    const token = signSession(user, { deviceId: device.id, scope: 'tap', ...(signin ? { sid: signin.id } : {}) }, { expiresIn: TAP_PASS_TTL });
    // A pass, not a session: no profile, nothing the tap page could open the HMS with.
    return success(res, { token, scope: 'tap', firstName: user.firstName });
  } catch (err) {
    console.error('Auth.deviceSession error:', err.message);
    return error(res, 'Could not check this phone. Please tap the tag again.', 500);
  }
};

// ------------------------------------
// POST /api/auth/device-register { code } — the phone enters the one-time
// code HR issued (services/checkinPhones.js). Answers with the phone's token,
// which the tap page keeps; nothing else. The pass comes from device-session,
// so the network lock is applied there, the same as every other tap.
// ------------------------------------
const registerDevice = async (req, res) => {
  try {
    const out = await redeemRegistration(req.body.code, req);
    if (out.error) return error(res, out.error, 400);
    return success(res, { deviceToken: out.deviceToken, firstName: out.user.firstName });
  } catch (err) {
    console.error('Auth.registerDevice error:', err);
    return error(res, 'Could not register this phone. Please try again.', 500);
  }
};

// ------------------------------------
// POST /api/auth/login
// ------------------------------------
// One answer for every refused sign-in (16 Oct 2026): it used to say "Invalid
// password" when the email existed, which told a caller which emails do.
const SIGNIN_REFUSED = 'Incorrect email or password, or the account is inactive.';
const DUMMY_HASH = bcrypt.hashSync('cdc-hms-no-such-account', 10);

const login = async (req, res) => {
  const { email, password } = req.body;

  // 1. Find user by email (role is determined by the account, not supplied by the client)
  const user = await User.findOne({ where: { email, isActive: true } });
  if (!user) {
    // Recorded as a failed attempt (sign-in tracking, 16 Oct 2026). The answer
    // stays the same either way, so it never tells a caller which emails exist.
    const inactive = await User.findOne({ where: { email }, attributes: ['id', 'firstName', 'lastName', 'role'] });
    // A bcrypt comparison either way, so the time taken does not tell either.
    await bcrypt.compare(String(password || ''), DUMMY_HASH);
    await recordSignin(req, inactive
      ? { user: inactive, outcome: 'failed', failReason: 'inactive' }
      : { outcome: 'failed', failReason: 'unknown_account', emailTried: email });
    return error(res, SIGNIN_REFUSED, 401);
  }

  // 2. Compare password
  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    await recordSignin(req, { user, outcome: 'failed', failReason: 'wrong_password' });
    return error(res, SIGNIN_REFUSED, 401);
  }

  // 2b. The network lock (16 Oct 2026): outside the clinic's networks only
  //     people with remote access may sign in. Checked after the password so
  //     the message never helps someone guessing one. 423, not 401/403: the
  //     browser shows the sentence without signing anyone out or toasting.
  if (blockedByLock({ user, ip: clientIp(req), cfg: await getSigninSecurityConfig() })) {
    await recordSignin(req, { user, outcome: 'failed', failReason: 'outside_blocked' });
    return error(res, LOCK_MESSAGE, 423, { code: 'OUTSIDE_CLINIC' });
  }

  // 3. (Removed 17 Oct 2026: "remember this phone" at sign-in. Only HR with
  //    hr.devices.register registers a check-in phone — POST /device-register.)

  // 4. Record the sign-in (staff only — never throws). Its id rides in the
  //    session token as `sid`, so the browser's location, when the clinic asks
  //    for it, can only ever be written onto this sign-in.
  const signin = await recordSignin(req, { user });

  // 5. Sign JWT
  const token = signSession(user, signin ? { sid: signin.id } : {});

  // 6. Build response with profile. signinGeo tells the browser whether to ask
  //    for its location now (Settings → Sign-in security; off unless switched on).
  const userData = await buildUserResponse(user);
  let signinGeo = 'off';
  if (signin) {
    try { signinGeo = (await getSigninSecurityConfig()).gpsMode; } catch { signinGeo = 'off'; }
  }

  return success(res, { token, user: userData, signinGeo });
};

// ------------------------------------
// POST /api/auth/signin-location { status, lat, lng, accuracy }
// The browser's own location for the sign-in in this session's token.
// ------------------------------------
const signinLocation = async (req, res) => {
  try {
    const written = await attachGps(req, req.body || {});
    return success(res, { recorded: written });
  } catch (err) {
    if (err.status === 400) return error(res, err.message, 400);
    console.error('Auth.signinLocation error:', err.message);
    return error(res, 'Could not record the location.', 500);
  }
};

// ------------------------------------
// POST /api/auth/forgot-password
// ------------------------------------
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ where: { email } });
  if (!user) return error(res, 'Email not found', 404);

  // Generate token and expiry (from .env: RESET_TOKEN_EXPIRES_IN in ms)
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpires = new Date(Date.now() + parseInt(process.env.RESET_TOKEN_EXPIRES_IN));

  await user.update({ resetToken, resetTokenExpires });

  // Send password reset email
  sendPasswordResetEmail({
    to: email,
    name: `${user.firstName} ${user.lastName}`,
    resetToken,
  }).catch(() => {});

  return success(res, { message: 'Password reset link sent to your email' });
};

// ------------------------------------
// POST /api/auth/reset-password
// ------------------------------------
const resetPassword = async (req, res) => {
  const { token, password } = req.body;

  // Find user with valid (non-expired) token
  const user = await User.findOne({
    where: {
      resetToken: token,
      resetTokenExpires: { [Op.gt]: new Date() }, // token must not be expired
    },
  });

  if (!user) return error(res, 'Invalid or expired reset token', 400);

  // Hash new password and clear the token
  const hashedPassword = await bcrypt.hash(password, 10);
  await user.update({
    password: hashedPassword,
    resetToken: null,
    resetTokenExpires: null,
    // The user chose this one themselves, so it restarts their rotation week.
    passwordChangedAt: new Date(),
  });

  return success(res, { message: 'Password reset successfully' });
};

// ------------------------------------
// GET /api/auth/me
// ------------------------------------
const getMe = async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return error(res, 'User not found', 404);

  const userData = await buildUserResponse(user);
  return success(res, userData);
};

// ------------------------------------
// PUT /api/auth/change-password
// ------------------------------------
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    // Get user from database (req.user comes from auth middleware)
    const user = await User.findByPk(req.user.id);
    if (!user) return error(res, 'User not found', 404);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return error(res, 'Current password is incorrect', 400);

    // Prevent using same password
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) return error(res, 'New password must be different from current password', 400);

    // Hash and save new password. passwordChangedAt is what clears an expired
    // account: the rotation gate re-reads it on the next request, so the user
    // is unblocked immediately without logging out and back in.
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword, passwordChangedAt: new Date() });

    const rotation = await getRotationStatus(user);
    return success(res, {
      message: 'Password changed successfully',
      passwordExpiresOn: rotation.expiresOn,
      passwordPolicyLabel: rotation.policyLabel,
    });
  } catch (err) {
    console.error('Change password error:', err.message);
    return error(res, 'Failed to change password. Please try again.', 500);
  }
};

// ------------------------------------
// Token blacklist for server-side logout
// In production, use Redis for distributed systems
// ------------------------------------
const tokenBlacklist = new Set();

const isTokenBlacklisted = (token) => tokenBlacklist.has(token);

// ------------------------------------
// POST /api/auth/logout
// ------------------------------------
const logout = async (req, res) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'No token provided', 400);
    }

    const token = authHeader.split(' ')[1];

    // Add token to blacklist
    tokenBlacklist.add(token);

    return success(res, { message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err.message);
    return error(res, 'Failed to logout. Please try again.', 500);
  }
};

module.exports = {
  login,
  deviceSession,
  registerDevice,
  signinLocation,
  forgotPassword,
  resetPassword,
  getMe,
  changePassword,
  logout,
  isTokenBlacklisted,
};
