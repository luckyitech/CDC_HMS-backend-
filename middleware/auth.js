const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');
const { isTokenBlacklisted } = require('../controllers/authController');

// Verifies the JWT token and attaches the decoded payload to req.user
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]; // expects "Bearer <token>"
  if (!token) return error(res, 'No token provided', 401);

  // Check if token has been invalidated (logged out)
  if (isTokenBlacklisted(token)) {
    return error(res, 'Token has been invalidated. Please login again.', 401);
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return error(res, 'Invalid or expired token', 401);
  }
};

// Checks req.user.role against the allowed roles passed in
// Usage: authorize('doctor', 'staff') — only those two roles can proceed
const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return error(res, 'Access denied', 403);
  next();
};

module.exports = { authenticate, authorize };
