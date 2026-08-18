const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
const { isTokenBlacklisted } = require('../controllers/authController');
const { getRotationStatus } = require('../utils/passwordRotation');
const db = require('../models');
const { PERMISSIONS, hasPermission, isDenied, isTrueAdmin } = require('../constants/permissions');
const { User } = db;

// Endpoints a staff member with an expired password may still reach. Enough to
// see who they are, set a new password, and leave — nothing else. Matched
// against the full path so a route file cannot accidentally widen it.
const ROTATION_EXEMPT_PATHS = [
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
];

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
      attributes: ['id', 'isActive', 'role', 'permissions', 'deniedPermissions', 'passwordChangedAt'],
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
  if (!ROTATION_EXEMPT_PATHS.includes(path)) {
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

  req.user = {
    ...decoded,
    role: user.role,                      // live, not as signed at login
    permissions: user.permissions || [],
    deniedPermissions: user.deniedPermissions || [],
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
  const roles = allow.filter((a) => !a.includes('.'));
  const perms = allow.filter((a) => a.includes('.'));
  if (perms.some((p) => isDenied(req.user, p))) {
    return error(res, 'You do not have permission to do that — an administrator has withdrawn this from your account.', 403);
  }
  if (roles.includes(req.user.role)) return next();
  if (roles.includes('admin') && hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS)) return next();
  if (perms.some((p) => hasPermission(req.user, p))) return next();
  return error(res, 'You do not have permission to do that.', 403);
};

// Requires a specific capability. One middleware for every permission, rather
// than a bespoke one per capability.
// Usage: requirePermission(PERMISSIONS.STOCK_WRITE)
const requirePermission = (permission) => (req, res, next) => {
  if (hasPermission(req.user, permission)) return next();
  return error(res, 'You do not have permission to do that — this has not been granted to your account.', 403);
};

// Requires the actual admin ACCOUNT, not merely admin capabilities. Reserved
// for the things that must not be self-propagating: a user granted admin access
// cannot in turn grant it to anyone else, or to themselves in greater measure.
// Without this, the permission would spread and could never be reliably revoked.
const requireTrueAdmin = (req, res, next) => {
  if (isTrueAdmin(req.user)) return next();
  return error(res, 'Only an administrator account can do this', 403);
};

module.exports = { authenticate, authorize, requirePermission, requireTrueAdmin };
