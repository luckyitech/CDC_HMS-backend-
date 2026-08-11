const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const findStaff = require('../middleware/findStaff');
const staffController = require('../controllers/staffController');

const EMPLOYMENT_STATUSES = ['Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'];
const EMPLOYMENT_TYPES    = ['Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'];

// Allows a staff member to reach their own record, and anyone with admin
// access to reach any record. Declared here rather than inside the controller
// so the route file still says who may call it.
const adminOrSelf = (req, res, next) => {
  if (req.user.role === 'admin') return next();
  if (req.staffUser && req.staffUser.id === req.user.id) return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
};

// ------------------------------------
// GET /api/staff/expiring-licences — licences expiring within 60 days
//
// Declared before /:employeeId, otherwise Express matches this path as an
// employee ID and findStaff returns 404.
// ------------------------------------
router.get('/expiring-licences', authenticate, authorize('admin'), staffController.expiringLicences);

// ------------------------------------
// GET /api/staff — list / search
// ------------------------------------
router.get('/', authenticate, authorize('admin'), staffController.list);

// ------------------------------------
// GET /api/staff/:employeeId — full profile
// ------------------------------------
router.get('/:employeeId', authenticate, findStaff, adminOrSelf, staffController.getOne);

// ------------------------------------
// PUT /api/staff/:employeeId — update profile
// ------------------------------------
router.put('/:employeeId', authenticate, authorize('admin'), findStaff, [
  body('firstName').optional().notEmpty().withMessage('First name cannot be empty'),
  body('lastName').optional().notEmpty().withMessage('Last name cannot be empty'),
  body('email').optional({ nullable: true }).isEmail().withMessage('Valid email is required'),
  body('gender').optional({ nullable: true }).isIn(['Male', 'Female', 'Other']).withMessage('Invalid gender'),
  body('employmentType').optional({ nullable: true }).isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  body('yearsExperience').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Years of experience must be a positive number'),
  body('emergencyContact').optional({ nullable: true }).isObject().withMessage('Emergency contact must be an object'),
  body('roleDetails').optional({ nullable: true }).isObject().withMessage('Role details must be an object'),
  validate,
], staffController.update);

// ------------------------------------
// PATCH /api/staff/:employeeId/status — change employment status
// ------------------------------------
router.patch('/:employeeId/status', authenticate, authorize('admin'), findStaff, [
  body('employmentStatus').isIn(EMPLOYMENT_STATUSES).withMessage('Invalid employment status'),
  validate,
], staffController.updateStatus);

// ------------------------------------
// DELETE /api/staff/:employeeId — archive (never destroys the record)
// ------------------------------------
router.delete('/:employeeId', authenticate, authorize('admin'), findStaff, staffController.archive);

// ------------------------------------
// PATCH /api/staff/:employeeId/restore — undo an archive
// ------------------------------------
router.patch('/:employeeId/restore', authenticate, authorize('admin'), findStaff, staffController.restore);

// ------------------------------------
// GET /api/staff/:employeeId/activity — login + edit history
// ------------------------------------
router.get('/:employeeId/activity', authenticate, authorize('admin'), findStaff, [
  param('employeeId').notEmpty(),
  validate,
], staffController.activity);

module.exports = router;
