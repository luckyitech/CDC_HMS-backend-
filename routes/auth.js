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
  body('role').isIn(['doctor', 'staff', 'lab', 'patient', 'admin']).withMessage('Valid role is required'),
  validate,
], authController.login);

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
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
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
