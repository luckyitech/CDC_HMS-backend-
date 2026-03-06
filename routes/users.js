const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const userController = require('../controllers/userController');

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
  body('employmentType').isIn(['Full-time', 'Part-time', 'Contract', 'Consultant']).withMessage('Invalid employment type'),
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
  body('shift').isIn(['Morning', 'Afternoon', 'Night']).withMessage('Invalid shift'),
  body('password').optional({ nullable: true }).isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  validate,
], userController.createStaff);

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
  body('shift').isIn(['Morning', 'Afternoon', 'Night']).withMessage('Invalid shift'),
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
// DELETE /api/users/:id — delete user
// ------------------------------------
router.delete('/:id', authenticate, authorize('admin'), userController.deleteUser);

module.exports = router;
