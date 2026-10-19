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
const { logLogin } = require('../services/activityLogService');
const loginOtp = require('../services/loginOtp');
const { appliesTo, getTwoFactorConfig, looksLikeCode, UNDELIVERABLE } = require('../utils/loginOtp');
const { getHrConfig } = require('../utils/hrConfig');
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
// Remembered phones (HR Suite, B21)
//
// The HMS session is per-tab sessionStorage, so a URL opened from the
// entrance NFC tag always lands logged out. A member of staff signs in ONCE
// on their own phone with rememberDevice; the phone keeps a long random
// token and every later tap exchanges it for a normal JWT here — no login.
// Only the token's SHA-256 is stored; it rolls forward `deviceDays` on every
// use and dies when the account is deactivated/archived or HR revokes it.
// ------------------------------------
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const deviceLabel = (ua = '') => {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : 'Phone';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
};
const signSession = (user, extra = {}) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, name: `${user.firstName} ${user.lastName}`, ...extra },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN }
);

const createRememberedDevice = async (user, req) => {
  const cfg = await getHrConfig();
  const raw = crypto.randomBytes(32).toString('base64url');
  const device = await UserDevice.create({
    UserId: user.id, tokenHash: sha256(raw), label: deviceLabel(req.headers['user-agent']),
    lastSeenAt: new Date(), lastIp: clientIp(req),
    expiresAt: new Date(Date.now() + cfg.deviceDays * 24 * 60 * 60 * 1000),
  });
  return { raw, device };
};

// ------------------------------------
// POST /api/auth/device-session { deviceToken }
// ------------------------------------
const deviceSession = async (req, res) => {
  try {
    const raw = String(req.body.deviceToken || '');
    if (raw.length < 32 || raw.length > 128) return error(res, 'This phone is no longer remembered — please sign in.', 401);
    const device = await UserDevice.findOne({ where: { tokenHash: sha256(raw), revokedAt: null } });
    if (!device || new Date(device.expiresAt) < new Date()) return error(res, 'This phone is no longer remembered — please sign in.', 401);
    const user = await User.findByPk(device.UserId);
    if (!user || !user.isActive || user.role === 'patient') return error(res, 'This phone is no longer remembered — please sign in.', 401);

    const cfg = await getHrConfig();
    await device.update({ lastSeenAt: new Date(), lastIp: clientIp(req), expiresAt: new Date(Date.now() + cfg.deviceDays * 24 * 60 * 60 * 1000) });
    logLogin(user, clientIp(req), 'device');
    const token = signSession(user, { deviceId: device.id });
    const userData = await buildUserResponse(user);
    return success(res, { token, user: userData });
  } catch (err) {
    console.error('Auth.deviceSession error:', err.message);
    return error(res, 'Could not open a session. Please sign in.', 500);
  }
};

// ------------------------------------
// Opening the session — the last four steps of a sign-in.
//
// Extracted because there are now two ways to reach them: a password alone
// (two-factor off) and a verified code (two-factor on). Keeping one copy is
// what stops the two paths drifting — a `method` recorded on one and not the
// other, or a remembered phone that works through one door only.
//
// `rememberDevice` and `context` are passed in rather than read from req.body:
// on the two-factor path they come from the challenge row, which recorded what
// the PASSWORD step asked for. See models/LoginOtp.js on why the verify request
// is not allowed to assert them for itself.
// ------------------------------------
const completeLogin = async (user, req, { rememberDevice = false, context = null, method = 'password' } = {}) => {
  // Remember this phone? Only honoured from the HR tap page, and only for
  // internal accounts — a patient never gets a device token.
  let deviceToken = null;
  let deviceId = null;
  if (rememberDevice === true && context === 'hr-tap' && user.role !== 'patient') {
    try {
      const { raw, device } = await createRememberedDevice(user, req);
      deviceToken = raw;
      deviceId = device.id;
    } catch (err) {
      console.error('Auth.completeLogin rememberDevice error:', err.message);   // login still succeeds
    }
  }

  // Sign JWT (carries the device id so a tap can record which phone sent it)
  const token = signSession(user, deviceId ? { deviceId } : {});

  // Record login event (staff / doctor / lab only — fire-and-forget). `method`
  // distinguishes a password-only sign-in from a two-factor one in the Activity
  // log, which is how an administrator can see the policy actually biting.
  logLogin(user, clientIp(req), method);

  const userData = await buildUserResponse(user);

  return { token, user: userData, ...(deviceToken ? { deviceToken } : {}) };
};

// ------------------------------------
// POST /api/auth/login
//
// With two-factor OFF this behaves exactly as it always has. With it ON, a
// correct password no longer returns a token — it returns a challenge, and
// POST /api/auth/verify-otp is what opens the session.
//
// NO TOKEN IS ISSUED BEFORE THE CODE IS ACCEPTED, not even a restricted one.
// middleware/auth.js admits any JWT signed with JWT_SECRET and re-reads role
// and permissions from the row, so a "pending" token would be a working
// session on every route in the system unless that middleware learned to
// refuse it. An opaque challenge id cannot be mistaken for a session by
// anything.
// ------------------------------------
const login = async (req, res) => {
  const { email, password } = req.body;

  // 1. Find user by email (role is determined by the account, not supplied by the client)
  const user = await User.findOne({ where: { email, isActive: true } });
  if (!user) return error(res, 'Invalid credentials or account is inactive', 401);

  // 2. Compare password
  const match = await bcrypt.compare(password, user.password);
  if (!match) return error(res, 'Invalid password', 401);

  // 3. Second factor, if this account is in scope. Read fresh (30s cache) so
  //    switching the policy on takes effect for the next sign-in, not the next
  //    deploy.
  const config = await getTwoFactorConfig();
  const rememberDevice = req.body.rememberDevice === true;
  const context = req.body.context === 'hr-tap' ? 'hr-tap' : null;

  if (appliesTo(user, config)) {
    const issued = await loginOtp.issueChallenge(user, {
      ip: clientIp(req), rememberDevice, context,
    });

    if (issued.outcome === UNDELIVERABLE.RESERVED_DOMAIN) {
      // The address on the account is a placeholder at a domain that cannot
      // receive mail (example.com, .test, .invalid). Named distinctly from
      // 'no-email' so the administrator is sent to replace a fiction rather
      // than to add something that is already there.
      return error(
        res,
        'The email address on your account cannot receive mail, so a sign-in code cannot be sent. Please ask an administrator to set a real email address on your account.',
        403,
        { code: 'OTP_UNDELIVERABLE_EMAIL' },
      );
    }

    if (issued.outcome === UNDELIVERABLE.NO_EMAIL) {
      // The password was right, so this is a real person locked out by a gap in
      // their own record rather than an attacker being refused. Say so plainly
      // and name the fix, because they cannot solve it themselves.
      return error(
        res,
        'Your account has no email address on file, so a sign-in code cannot be sent. Please ask an administrator to add your email address.',
        403,
        { code: 'OTP_NO_EMAIL' },
      );
    }

    if (issued.outcome === 'send-failed') {
      console.error('Auth.login OTP send failed:', issued.error?.message);
      // Deliberately NOT let through on the password alone. A mail outage is
      // exactly when an attacker holding a stolen password would most like the
      // second factor to be skipped.
      return error(
        res,
        'We could not send your sign-in code. Please try again in a moment, or contact your administrator if it keeps failing.',
        503,
        { code: 'OTP_SEND_FAILED' },
      );
    }

    // 401 with a code the frontend branches on, like PASSWORD_ROTATION_REQUIRED.
    // The masked address is returned because "we sent you a code" is not
    // actionable if the person cannot tell which of their mailboxes to open.
    return error(res, 'We have emailed you a sign-in code.', 401, {
      code: 'OTP_REQUIRED',
      challengeId: issued.challengeId,
      maskedEmail: issued.maskedEmail,
      expiresAt: issued.expiresAt,
      expiresMinutes: issued.expiresMinutes,
    });
  }

  // 4. Two-factor off (or out of scope for this role) — open the session now.
  const payload = await completeLogin(user, req, { rememberDevice, context, method: 'password' });
  return success(res, payload);
};

// ------------------------------------
// POST /api/auth/verify-otp { challengeId, code }
//
// The second half of a two-factor sign-in. The challenge row says which
// account this is for, so nothing here is taken from the client except the
// code itself.
// ------------------------------------
const verifyOtp = async (req, res) => {
  try {
    const { challengeId, code } = req.body;

    // Shape-checked before the lookup so a malformed code never costs the user
    // one of their real attempts.
    if (!looksLikeCode(code)) {
      return error(res, 'Enter the 6-digit code from your email.', 400, { code: 'OTP_MALFORMED' });
    }

    const result = await loginOtp.verifyChallenge(challengeId, String(code).trim(), { ip: clientIp(req) });

    switch (result.outcome) {
      case 'ok': {
        const payload = await completeLogin(result.user, req, {
          rememberDevice: result.rememberDevice,
          context: result.context,
          method: 'otp',
        });
        return success(res, payload);
      }

      // 400, not 401: a wrong code is a retry on the page the user is already
      // on. A 401 would be caught by the frontend's axios interceptor, which
      // clears the session and bounces the browser — throwing the person off
      // the very screen they are meant to type the next code into.
      case 'bad-code':
        return error(
          res,
          result.attemptsLeft === 1
            ? 'That code is not right. You have 1 attempt left before you need to sign in again.'
            : `That code is not right. You have ${result.attemptsLeft} attempts left.`,
          400,
          { code: 'OTP_BAD_CODE', attemptsLeft: result.attemptsLeft },
        );

      case 'expired':
        return error(res, 'That code has expired. Please sign in again to get a new one.', 400, { code: 'OTP_EXPIRED' });

      case 'attempts-exhausted':
        return error(res, 'Too many incorrect codes. Please sign in again.', 400, { code: 'OTP_ATTEMPTS_EXHAUSTED' });

      case 'consumed':
        return error(res, 'That code has already been used. Please sign in again.', 400, { code: 'OTP_CONSUMED' });

      case 'account-unusable':
        return error(res, 'Your account has been deactivated. Please contact the administrator.', 401);

      case 'not-found':
      default:
        // One message for "no such challenge" and for a stale one, so this
        // cannot be used to learn which challenge ids exist.
        return error(res, 'This sign-in has expired. Please sign in again.', 400, { code: 'OTP_NOT_FOUND' });
    }
  } catch (err) {
    console.error('Auth.verifyOtp error:', err.message);
    return error(res, 'Could not check your code. Please try again.', 500);
  }
};

// ------------------------------------
// POST /api/auth/resend-otp { challengeId }
//
// A new code for a sign-in already in progress. The attempt count is kept, so
// this is not a way to reset a nearly-exhausted challenge.
// ------------------------------------
const resendOtp = async (req, res) => {
  try {
    const result = await loginOtp.resendChallenge(req.body.challengeId, { ip: clientIp(req) });

    switch (result.outcome) {
      case 'sent':
        return success(res, {
          message: 'We have emailed you a new code.',
          challengeId: result.challengeId,
          maskedEmail: result.maskedEmail,
          expiresAt: result.expiresAt,
          expiresMinutes: result.expiresMinutes,
          resendsLeft: result.resendsLeft,
        });

      case 'resend-limit':
        return error(res, 'We have sent you several codes already. Please sign in again.', 429, { code: 'OTP_RESEND_LIMIT' });

      case 'send-failed':
        console.error('Auth.resendOtp send failed:', result.error?.message);
        return error(res, 'We could not send your sign-in code. Please try again in a moment.', 503, { code: 'OTP_SEND_FAILED' });

      case 'expired':
      case 'consumed':
      case 'attempts-exhausted':
      case 'not-found':
      default:
        return error(res, 'This sign-in has expired. Please sign in again.', 400, { code: 'OTP_NOT_FOUND' });
    }
  } catch (err) {
    console.error('Auth.resendOtp error:', err.message);
    return error(res, 'Could not send a new code. Please try again.', 500);
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
  verifyOtp,
  resendOtp,
  deviceSession,
  forgotPassword,
  resetPassword,
  getMe,
  changePassword,
  logout,
  isTokenBlacklisted,
};
