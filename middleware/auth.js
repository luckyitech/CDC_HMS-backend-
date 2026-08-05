const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
const { isTokenBlacklisted } = require('../controllers/authController');
const db = require('../models');
const { PERMISSIONS, hasPermission, isTrueAdmin } = require('../constants/permissions');
const { User } = db;

// Verifies the JWT token and attaches the decoded payload to req.user.
// Also checks isActive on every request so deactivation takes effect immediately.
//
// role and permissions come from the DATABASE, not from the token. The token is
// signed at login, so a permission granted or revoked afterwards would not reach
// a signed-in user until they logged out and back in — a revoked admin would
// keep admin access for the life of their session, which is exactly when you
// least want it. This costs nothing: the isActive lookup below already happens
// on every request, so it is the same query returning two more columns.
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
      attributes: ['id', 'isActive', 'role', 'permissions'],
    });
  } catch {
    return error(res, 'Authentication service unavailable. Please try again.', 503);
  }
  if (!user || !user.isActive) {
    return error(res, 'Your account has been deactivated. Please contact the administrator.', 401);
  }

  req.user = {
    ...decoded,
    role: user.role,                      // live, not as signed at login
    permissions: user.permissions || [],
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
const authorize = (...roles) => (req, res, next) => {
  if (roles.includes(req.user.role)) return next();
  if (roles.includes('admin') && hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS)) return next();
  return error(res, 'Access denied', 403);
};

// Requires a specific capability. One middleware for every permission, rather
// than a bespoke one per capability.
// Usage: requirePermission(PERMISSIONS.STOCK_MANAGE)
const requirePermission = (permission) => (req, res, next) => {
  if (hasPermission(req.user, permission)) return next();
  return error(res, 'Access denied — this has not been granted to your account', 403);
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
