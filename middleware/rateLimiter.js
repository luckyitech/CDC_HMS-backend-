const rateLimit = require('express-rate-limit');

// ====================================
// RATE LIMITING CONFIGURATION
// ====================================
// Rate limiting prevents brute force attacks and API abuse
// by limiting how many requests a client can make in a time window

// ------------------------------------
// General API Rate Limiter
// ------------------------------------
// Applied to ALL API endpoints
// Allows 1000 requests per 15 minutes per IP (increased for development)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs (dev mode)
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip successful requests (only count failed ones)
  skipSuccessfulRequests: false,
});

// ------------------------------------
// Auth Rate Limiter (STRICT)
// ------------------------------------
// Applied to authentication endpoints (login, password reset)
// Allows 50 attempts per 15 minutes per IP (increased for development)
// WHY: Prevents brute force password attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 login attempts per windowMs (dev mode)
  message: {
    success: false,
    message: 'Too many login attempts from this IP, please try again after 15 minutes.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests - only count failed login attempts
  skipSuccessfulRequests: true,
});

// ------------------------------------
// Strict Rate Limiter
// ------------------------------------
// For sensitive operations (password reset, account creation)
// Allows only 3 attempts per hour per IP
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Limit each IP to 3 requests per hour
  message: {
    success: false,
    message: 'Too many attempts for this operation, please try again after 1 hour.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ------------------------------------
// EXPORTS
// ------------------------------------
module.exports = {
  generalLimiter,
  authLimiter,
  strictLimiter,
};
