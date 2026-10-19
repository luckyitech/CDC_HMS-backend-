const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { authLimiter, otpLimiter, strictLimiter } = require('../middleware/rateLimiter');
const authController = require('../controllers/authController');

// POST /api/auth/login
// Rate limit: 5 attempts per 15 minutes (prevents brute force attacks)
router.post('/login', authLimiter, [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
], authController.login);

// POST /api/auth/verify-otp — the second half of a two-factor sign-in.
// The challenge id says which account this is for, so no email or password is
// re-sent here. Both fields are shape-checked: a malformed code must not cost
// the user one of their real attempts.
router.post('/verify-otp', otpLimiter, [
  body('challengeId').isString().isLength({ min: 20, max: 64 }).withMessage('challengeId is required'),
  body('code').isString().trim().matches(/^\d{6}$/).withMessage('Enter the 6-digit code from your email'),
  validate,
], authController.verifyOtp);

// POST /api/auth/resend-otp — a fresh code for a sign-in already in progress.
// Capped per challenge in services/loginOtp.js as well as per IP here, because
// this one sends mail.
router.post('/resend-otp', otpLimiter, [
  body('challengeId').isString().isLength({ min: 20, max: 64 }).withMessage('challengeId is required'),
  validate,
], authController.resendOtp);

// POST /api/auth/device-session — a remembered phone (HR Suite tap page)
// exchanges its long-lived token for a normal session. Same limiter as login:
// a guessed token is a login attempt.
router.post('/device-session', authLimiter, [
  body('deviceToken').isString().isLength({ min: 32, max: 128 }).withMessage('deviceToken is required'),
  validate,
], authController.deviceSession);

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
