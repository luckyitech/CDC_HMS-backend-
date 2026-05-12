const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
const { isTokenBlacklisted } = require('../controllers/authController');
const db = require('../models');
const { User } = db;

// Verifies the JWT token and attaches the decoded payload to req.user.
// Also checks isActive on every request so deactivation takes effect immediately.
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

  // Verify the account is still active in the database
  let user;
  try {
    user = await User.findByPk(decoded.id, { attributes: ['id', 'isActive'] });
  } catch {
    return error(res, 'Authentication service unavailable. Please try again.', 503);
  }
  if (!user || !user.isActive) {
    return error(res, 'Your account has been deactivated. Please contact the administrator.', 401);
  }

  req.user = decoded;
  next();
};

// Checks req.user.role against the allowed roles passed in
// Usage: authorize('doctor', 'staff') — only those two roles can proceed
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return error(res, 'Access denied', 403);
  next();
};

module.exports = { authenticate, authorize };
