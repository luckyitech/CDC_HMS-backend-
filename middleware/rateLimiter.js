const rateLimit = require('express-rate-limit');

// ====================================
// RATE LIMITING CONFIGURATION
// ====================================
// Rate limiting prevents brute force attacks and API abuse
// by limiting how many requests a client can make in a time window

// Custom key generator — normalizes IP for rate limiting
// Handles IIS forwarding IP:port format e.g. "197.248.95.205:58192" → "197.248.95.205"
// Handles IPv4-mapped IPv6 e.g. "::ffff:197.248.95.205" → "197.248.95.205"
// Wraps bare IPv6 in brackets as required by express-rate-limit
const keyGenerator = (req) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  let cleaned = ip.replace(/^::ffff:/, '');
  cleaned = cleaned.replace(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/, '$1');
  if (cleaned.includes(':')) return `[${cleaned}]`;
  return cleaned;
};

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
  skipSuccessfulRequests: false,
  keyGenerator,
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
  skipSuccessfulRequests: true,
  keyGenerator,
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
  keyGenerator,
});

// ------------------------------------
// SSE Rate Limiter
// ------------------------------------
// Applied to the SSE endpoint only.
// SSE holds persistent connections — limit each IP to 20 connections
// per 15 minutes to prevent connection-flood DoS attacks.
const sseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    success: false,
    message: 'Too many SSE connections from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
});

// ------------------------------------
// EXPORTS
// ------------------------------------
module.exports = {
  generalLimiter,
  authLimiter,
  strictLimiter,
  sseLimiter,
};
