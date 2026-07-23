const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const glp1MedicationController = require('../controllers/glp1MedicationController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST (GET):       DOCTORS and ADMINS — this drives the medication tabs
// CREATE (POST):    ADMINS only — a formulary entry becomes an option for every patient
// UPDATE (PUT):     ADMINS only
// DELETE (DELETE):  ADMINS only, and it retires rather than destroys

// ------------------------------------
// GET /api/glp1-medications — List the clinic formulary
// ------------------------------------
// Authorization: Doctor, Admin
// Query: ?active=false to include retired agents
router.get(
  '/',
  authenticate,
  authorize('doctor', 'admin'),
  glp1MedicationController.list
);

// ------------------------------------
// POST /api/glp1-medications — Add an agent to the formulary
// ------------------------------------
// Authorization: Admin only
// Why? Adding an agent changes the options shown for every patient in the clinic
router.post(
  '/',
  authenticate,
  authorize('admin'),
  [
    body('genericName')
      .trim()
      .notEmpty()
      .withMessage('Generic name is required'),
    body('brandName')
      .optional()
      .isString()
      .withMessage('Brand name must be a string'),
    body('drugClass')
      .optional()
      .isString()
      .withMessage('Drug class must be a string'),
    body('route')
      .optional()
      .isString()
      .withMessage('Route must be a string'),
    body('strengths')
      .isArray({ min: 1 })
      .withMessage('At least one available strength is required'),
    body('defaultTitrationWeeks')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Default titration interval must be a whole number of weeks'),
    body('defaultSchedule')
      .optional()
      .isArray()
      .withMessage('Default schedule must be an array of dose steps'),
    validate,
  ],
  glp1MedicationController.create
);

// ------------------------------------
// PUT /api/glp1-medications/:id — Update a formulary entry
// ------------------------------------
// Authorization: Admin only
router.put(
  '/:id',
  authenticate,
  authorize('admin'),
  [
    body('genericName')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Generic name cannot be empty'),
    body('strengths')
      .optional()
      .isArray({ min: 1 })
      .withMessage('At least one available strength is required'),
    body('defaultTitrationWeeks')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Default titration interval must be a whole number of weeks'),
    body('defaultSchedule')
      .optional()
      .isArray()
      .withMessage('Default schedule must be an array of dose steps'),
    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be true or false'),
    validate,
  ],
  glp1MedicationController.update
);

// ------------------------------------
// DELETE /api/glp1-medications/:id — Retire an agent
// ------------------------------------
// Authorization: Admin only
// Sets isActive false. Patients already on the agent keep their course.
router.delete(
  '/:id',
  authenticate,
  authorize('admin'),
  glp1MedicationController.retire
);

module.exports = router;
