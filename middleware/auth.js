const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
const { isTokenBlacklisted } = require('../controllers/authController');
const { getRotationStatus } = require('../utils/passwordRotation');
const db = require('../models');
const { hasPermission, canGrantPermissions, gateResult } = require('../constants/permissions');
const { User } = db;
const { getSigninSecurityConfig } = require('../utils/signinSecurityConfig');
const { blockedByLock, LOCK_MESSAGE } = require('../utils/networkLock');
const { clientIp } = require('../utils/ip');

// Endpoints a staff member with an expired password may still reach. Enough to
// see who they are, set a new password, and leave — nothing else. Matched
// against the full path so a route file cannot accidentally widen it.
const ROTATION_EXEMPT_PATHS = [
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/signin-location',
];

// A check-in phone's pass (scope 'tap', authController.deviceSession) opens
// these and nothing else (17 Oct 2026, Emu: a phone registered for check-in
// does not get a sign-in to the HMS). Method and full path, like the list above.
const TAP_PASS_PATHS = [
  'POST /api/hr/attendance/tap',
  'GET /api/hr/attendance/checkin-config',
  'POST /api/auth/logout',
];
const TAP_ONLY_MESSAGE = 'This phone is registered for check-in only. Sign in with your password to use the HMS.';

// Verifies the JWT token and attaches the decoded payload to req.user.
// Also checks isActive on every request so deactivation takes effect immediately,
// and — when scheduled rotation is on — blocks users whose password has expired
// from doing anything except changing it.
//
// role, permissions and passwordChangedAt come from the DATABASE, not from the
// token. The token is signed at login, so anything changed afterwards would not
// reach a signed-in user until they logged out and back in — a revoked admin
// would keep admin access for the life of their session, and a user who had just
// set a new password would stay locked out. This costs nothing: the isActive
// lookup below already happens on every request, so it is the same query
// returning three more columns.
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]; // expects "Bearer <token>"
  if (!token) return error(res, 'No token provided', 401);

  // Check if token has been invalidated (logged out)
  if (isTokenBlacklisted(token)) {
    return error(res, 'Token has been invalidated. Please login again.', 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return error(res, 'Invalid or expired token', 401);
  }

  // Verify the account is still active, and read live role + permissions
  let user;
  try {
    user = await User.findByPk(decoded.id, {
      attributes: ['id', 'isActive', 'role', 'permissions', 'deniedPermissions', 'staffType', 'passwordChangedAt'],
    });
  } catch {
    return error(res, 'Authentication service unavailable. Please try again.', 503);
  }
  if (!user || !user.isActive) {
    return error(res, 'Your account has been deactivated. Please contact the administrator.', 401);
  }

  // Scheduled rotation gate. Read from the DB rather than the JWT so that
  // setting a new password unlocks the account on the very next request — no
  // re-login, and no window where an old token still carries "not expired".
  // Query string dropped, and a trailing slash normalised away — Express routes
  // '/api/auth/me/' to the same handler, so the allowlist has to match it too
  // or the user is locked out of the very screen they are being sent to.
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';
  const tapPass = decoded.scope === 'tap';
  if (tapPass && !TAP_PASS_PATHS.includes(`${req.method} ${path}`)) {
    return error(res, TAP_ONLY_MESSAGE, 403, { code: 'TAP_ONLY' });
  }
  // A check-in pass can do nothing but check in, so an expired password does
  // not stop the tap — the password is changed at the next real sign-in.
  if (!tapPass && !ROTATION_EXEMPT_PATHS.includes(path)) {
    const rotation = await getRotationStatus(user);
    if (rotation.mustChangePassword) {
      return error(
        res,
        'Your password has expired. Please set a new password to continue.',
        403,
        { code: 'PASSWORD_ROTATION_REQUIRED' }
      );
    }
  }

  // The network lock (16 Oct 2026): a session that leaves the clinic network
  // stops working unless this person has remote access. 401 + code, so the
  // browser signs out and the sign-in page says why. Read from a 15 s cache.
  try {
    const lockCfg = await getSigninSecurityConfig();
    if (lockCfg.lockOutside && blockedByLock({ user, ip: clientIp(req), cfg: lockCfg, viaDevice: tapPass })) {
      return error(res, LOCK_MESSAGE, 401, { code: 'OUTSIDE_CLINIC' });
    }
  } catch (err) {
    console.error('Auth.networkLock error:', err.message);   // a settings read failure never locks anyone out
  }

  req.user = {
    ...decoded,
    role: user.role,                      // live, not as signed at login
    permissions: user.permissions || [],
    deniedPermissions: user.deniedPermissions || [],
    // Read live, like role above. Reclassifying someone clinical or
    // non-clinical takes effect on their very next request rather than at their
    // next login — which is the point of a control an admin reaches for when
    // something has gone wrong.
    staffType: user.staffType,
  };
  next();
};

// Checks req.user.role against the allowed roles passed in
// Usage: authorize('doctor', 'staff') — only those two roles can proceed
//
// 'admin' is special: a user granted ADMIN_ACCESS passes any check that admits
// admins, without the 34 call sites across the route files having to know that
// permissions exist. Granting the capability is what makes those endpoints
// reachable; the routes stay declarative.
//
// Where something must be restricted to a REAL admin — granting permissions,
// anything that could make a grant irrevocable — use requireTrueAdmin below.
// Accepts roles and/or capabilities in one list. An argument containing a dot
// (e.g. 'inpatient.access') is treated as a permission, so a route can allow
// "these roles, OR anyone granted this capability" — e.g. authorize(...READ)
// where READ carries 'inpatient.access'. Role-only calls are unaffected.
//
// A capability named in the gate can also be WITHDRAWN from one person, which
// is checked first: an admin may hold a particular user out of a section their
// role would otherwise open. Checking it before the role match is the whole
// point — testing it afterwards would make a withdrawal do nothing for exactly
// the people it is meant to apply to.
//
// Only sections whose capability appears in the gate can be withdrawn. That is
// deliberate: a route that names no capability is role-only by design, and
// silently making every gate deniable would turn every hardcoded clinical role
// list into something an admin could quietly switch off.
const authorize = (...allow) => (req, res, next) => {
  const result = gateResult(req.user, allow);
  if (result === 'ok') return next();
  if (result === 'denied') {
    return error(res, 'You do not have permission to do that — an administrator has withdrawn this from your account.', 403);
  }
  return error(res, 'You do not have permission to do that.', 403);
};

// Requires a specific capability. One middleware for every permission, rather
// than a bespoke one per capability.
// Usage: requirePermission(PERMISSIONS.STOCK_WRITE)
const requirePermission = (permission) => (req, res, next) => {
  if (hasPermission(req.user, permission)) return next();
  return error(res, 'You do not have permission to do that — this has not been granted to your account.', 403);
};

// Requires a PERMISSIONS ADMINISTRATOR: someone holding permissions.grant, or
// the true admin account as the no-lockout fallback. Reserved for the things
// that must not be self-propagating — chiefly granting capabilities. A user
// holding admin.access does NOT pass this: they can run the clinic but cannot
// mint new administrators, so a grant can always be traced to a key-holder and
// reliably revoked. (Name kept for the call sites; the check is now a
// capability.) Decision: claude/session-2026-09-24-permissions-grant-decision.md
const requireTrueAdmin = (req, res, next) => {
  if (canGrantPermissions(req.user)) return next();
  return error(res, 'Only a permissions administrator can do this', 403);
};

module.exports = { authenticate, authorize, requirePermission, requireTrueAdmin };
