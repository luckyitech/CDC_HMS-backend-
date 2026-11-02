const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter, strictLimiter } = require('../middleware/rateLimiter');
const authController = require('../controllers/authController');

// POST /api/auth/login
// Rate limit: 5 attempts per 15 minutes (prevents brute force attacks)
router.post('/login', authLimiter, [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
], authController.login);

// POST /api/auth/gate-check — the check-in gate's "check again" (2 Nov 2026).
// Carries the short-lived gate ticket login handed back, never a password, so
// it is not counted against the sign-in limit the clinic's one address shares.
router.post('/gate-check', [
  body('ticket').isString().isLength({ min: 20, max: 1024 }).withMessage('Please sign in again.'),
  validate,
], authController.gateCheck);

// POST /api/auth/device-session — a remembered phone (HR Suite tap page)
// exchanges its long-lived token for a normal session. Same limiter as login:
// a guessed token is a login attempt.
router.post('/device-session', authLimiter, [
  body('deviceToken').isString().isLength({ min: 32, max: 128 }).withMessage('deviceToken is required'),
  validate,
], authController.deviceSession);

// POST /api/auth/device-register — a phone enters the one-time code HR issued
// (17 Oct 2026: only HR registers check-in phones). Same limiter: a guessed
// code is a login attempt; successful ones are not counted.
router.post('/device-register', authLimiter, [
  body('code').isString().isLength({ min: 8, max: 16 }).withMessage('Enter the code HR gave you'),
  validate,
], authController.registerDevice);

// POST /api/auth/forgot-password
// Rate limit: 3 attempts per hour (prevents abuse)
router.post('/forgot-password', strictLimiter, [
  body('email').isEmail().withMessage('Valid email is required'),
  validate,
], authController.forgotPassword);

// POST /api/auth/reset-password
// Rate limit: 3 attempts per hour (prevents token guessing)
router.post('/reset-password', strictLimiter, [
  body('token').notEmpty().withMessage('Token is required'),
  body('password').isStrongPassword({ minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 }).withMessage('Password must be at least 8 characters and include an uppercase letter, a number, and a special character'),
  validate,
], authController.resetPassword);

// GET /api/auth/me  — protected, needs a valid token
// The browser's own location for this session's sign-in (sign-in tracking,
// 16 Oct 2026). Written once, onto the row in the caller's own token.
router.post('/signin-location', authenticate, [
  body('status').isIn(['given', 'declined', 'unavailable']).withMessage("status must be 'given', 'declined' or 'unavailable'"),
  body('lat').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('lng').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  body('accuracy').optional({ nullable: true }).isFloat({ min: 0 }),
  validate,
], authController.signinLocation);

router.get('/me', authenticate, authController.getMe);

// PUT /api/auth/change-password — change password (authenticated)
router.put('/change-password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  validate,
], authController.changePassword);

// POST /api/auth/logout — server-side logout (authenticated)
router.post('/logout', authenticate, authController.logout);

module.exports = router;
