const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// ====================================
// RATE LIMITING CONFIGURATION
// ====================================
// Rate limiting prevents brute force attacks and API abuse
// by limiting how many requests a client can make in a time window

// The client's address, for counting. IIS forwards it as "IP:port"
// ("197.248.95.205:58192"), and the port changes with every connection, so it
// is stripped; "::ffff:1.2.3.4" becomes "1.2.3.4". The bare address goes to
// ipKeyGenerator, which groups an IPv6 address by its /56 network.
//
// 1 Nov 2026: this used to pass the whole request to ipKeyGenerator, which
// handed the request back as the key — every request got a bucket of its own,
// so no limiter here ever limited, login included.
const clientIp = (req) => {
  const raw = String(req.ip || req.socket?.remoteAddress || '');
  return raw
    .replace(/^::ffff:/, '')
    .replace(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/, '$1')
    .replace(/^\[([0-9a-fA-F:.]+)\]:\d+$/, '$1');
};

const keyGenerator = (req) => ipKeyGenerator(clientIp(req));

// Watch mode, for the limiters the clinic's own traffic goes through. Every
// workstation reaches the server from the clinic's one public address, so a
// per-address limit is a clinic-wide limit, and the numbers below were never
// tested against a real clinic day (they never limited — see above). Until
// they are, these limiters only log, once per address per window, when they
// WOULD have refused a request, and let it through:
//   [rate-limit] general would refuse 41.90.x.x — 1000 requests in 15 min
// Read the log after a week of clinic days (pm2 logs cdc-hms-api | grep rate-limit),
// set the limits, then drop `watch(...)` to enforce.
const warned = new Map(); // `${name}|${key}` → when the window it was logged in ends
const watch = (name) => (req, res, next, options) => {
  const key = req.rateLimit?.key;
  const tag = `${name}|${key}`;
  const now = Date.now();
  const resetAt = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() : now + options.windowMs;
  if (!(warned.get(tag) > now)) {
    warned.set(tag, resetAt);
    for (const [t, until] of warned) if (until <= now) warned.delete(t);
    console.warn(`[rate-limit] ${name} would refuse ${key} — ${req.rateLimit?.used} requests in ${Math.round(options.windowMs / 60000)} min (watch mode, let through)`);
  }
  next();
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
  handler: watch('general'),
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
  handler: watch('strict'),
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
  handler: watch('sse'),
});

// ------------------------------------
// Public Booking Rate Limiter
// ------------------------------------
// For the unauthenticated website booking POST. Tighter than the general
// limiter because it writes real appointments into the live schedule.
// Allows 10 booking attempts per 15 minutes per IP.
const publicBookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: {
    success: false,
    message: 'Too many booking attempts from this device. Please try again shortly, or contact the clinic.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
});

// ------------------------------------
// WhatsApp Webhook Rate Limiter
// ------------------------------------
// For the PUBLIC Meta webhook. Meta can burst several events per second on a
// busy number, so this is generous — 600 requests per minute per IP — but still
// caps an unauthenticated flood. Its own limiter because the webhook is mounted
// before the general limiter (raw body, signature verification).
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { success: false, message: 'Too many requests.' },
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
  publicBookingLimiter,
  webhookLimiter,
  keyGenerator,
  clientIp,
  watch,
};
