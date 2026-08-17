const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const userController = require('../controllers/userController');

const SHIFTS           = ['Morning', 'Afternoon', 'Night', 'Rotating'];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'];

// Shared across the four create routes: every cadre now writes to the same
// StaffProfile table, so the identity and contact fields are validated the same
// way regardless of which form submitted them. Spread these into a route's
// validator array rather than repeating the rules four times.
const IDENTITY_VALIDATORS = [
  body('dateOfBirth').optional({ nullable: true }).isISO8601().withMessage('Invalid date of birth'),
  body('gender').optional({ nullable: true }).isIn(['Male', 'Female', 'Other']).withMessage('Invalid gender'),
  body('idNumber').optional({ nullable: true }).isString(),
  body('address').optional({ nullable: true }).isString(),
  body('city').optional({ nullable: true }).isString(),
  body('emergencyContact').optional({ nullable: true }).isObject().withMessage('Emergency contact must be an object'),
  body('startDate').optional({ nullable: true }).isISO8601().withMessage('Invalid start date'),
  body('licenseBody').optional({ nullable: true }).isString(),
  body('licenseExpiry').optional({ nullable: true }).isISO8601().withMessage('Invalid licence expiry date'),
];

const SHIFT_VALIDATOR = [
  body('shift').optional({ nullable: true, checkFalsy: true }).isIn(SHIFTS).withMessage('Invalid shift'),
];

// ------------------------------------
// GET /api/users/doctors — list active doctors (any authenticated user)
// Used by patients when booking appointments
// ------------------------------------
router.get('/doctors', authenticate, userController.listDoctors);

// All routes require admin authentication
// ------------------------------------
// POST /api/users/doctors — create doctor
// ------------------------------------
router.post('/doctors', authenticate, authorize('admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('licenseNumber').notEmpty().withMessage('License number is required'),
  body('specialty').notEmpty().withMessage('Specialty is required'),
  body('department').notEmpty().withMessage('Department is required'),
  body('qualification').notEmpty().withMessage('Qualification is required'),
  body('medicalSchool').optional({ nullable: true }).isString(),
  body('yearsExperience').isInt({ min: 0 }).withMessage('Years of experience must be a positive number'),
  body('employmentType').isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  ...IDENTITY_VALIDATORS,
  body('password').optional({ nullable: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
], userController.createDoctor);

// ------------------------------------
// POST /api/users/staff — create staff
// ------------------------------------
router.post('/staff', authenticate, authorize('admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('position').notEmpty().withMessage('Position is required'),
  body('department').notEmpty().withMessage('Department is required'),
  // Shift is optional now. It used to be required, which forced the create form
  // to hardcode 'Morning' on every submission — so the column recorded nothing
  // real. A hospital not running shifts can leave it blank.
  ...SHIFT_VALIDATOR,
  ...IDENTITY_VALIDATORS,
  body('password').optional({ nullable: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
], userController.createStaff);

// ------------------------------------
// POST /api/users/nurses — create nurse (HMIS V3)
// ------------------------------------
router.post('/nurses', authenticate, authorize('admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  // Nurses previously borrowed the staff profile and could not record a council
  // registration number at all. These are optional so existing callers keep
  // working, but the fields now reach the database.
  body('licenseNumber').optional({ nullable: true }).isString(),
  body('qualification').optional({ nullable: true }).isString(),
  body('yearsExperience').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Years of experience must be a positive number'),
  body('certifications').optional({ nullable: true }).isArray().withMessage('Certifications must be a list'),
  ...SHIFT_VALIDATOR,
  ...IDENTITY_VALIDATORS,
  body('password').optional({ nullable: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
], userController.createNurse);

// ------------------------------------
// POST /api/users/lab-techs — create lab tech
// ------------------------------------
router.post('/lab-techs', authenticate, authorize('admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('specialization').notEmpty().withMessage('Specialization is required'),
  body('certificationNumber').notEmpty().withMessage('Certification number is required'),
  body('qualification').notEmpty().withMessage('Qualification is required'),
  body('institution').optional({ nullable: true }).isString(),
  body('yearsExperience').isInt({ min: 0 }).withMessage('Years of experience must be a positive number'),
  ...SHIFT_VALIDATOR,
  ...IDENTITY_VALIDATORS,
  body('password').optional({ nullable: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
], userController.createLabTech);

// ------------------------------------
// GET /api/users — list all users
// ------------------------------------
router.get('/', authenticate, authorize('admin'), userController.listUsers);

// ------------------------------------
// PUT /api/users/:id — update user
// ------------------------------------
router.put('/:id', authenticate, authorize('admin'), userController.updateUser);

// ------------------------------------
// PUT /api/users/:id/status — toggle status
// ------------------------------------
router.put('/:id/status', authenticate, authorize('admin'), [
  body('isActive').isBoolean().withMessage('isActive must be a boolean'),
  validate,
], userController.updateStatus);

// ------------------------------------
// GET /api/users/:id — get single user
// ------------------------------------
router.get('/:id', authenticate, authorize('admin'), userController.getById);

// ------------------------------------
// GET /api/users/:id/edit-logs — get edit history for a user
// ------------------------------------
router.get('/:id/edit-logs', authenticate, authorize('admin'), userController.getEditLogs);

// ------------------------------------
// DELETE /api/users/:id — delete user
// ------------------------------------
router.delete('/:id', authenticate, authorize('admin'), userController.deleteUser);

module.exports = router;
