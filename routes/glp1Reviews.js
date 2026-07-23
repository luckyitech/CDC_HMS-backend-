const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const glp1ReviewController = require('../controllers/glp1ReviewController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST (GET):      DOCTORS and STAFF can read
// CREATE (POST):   DOCTORS and STAFF — monitoring visits are filled by whoever
//                  sees the patient, doctor or nurse. The id stamped on the row
//                  comes from the token and is the Clinician column.
// AMEND (PUT):     DOCTORS and STAFF, and always with a written reason.
//                  The original author is never overwritten.
// REMOVE (DELETE): DOCTORS and ADMINS — soft delete, the row stays
//
// Starting and stopping a course stays doctor-only: that is a prescribing
// decision and lives in routes/glp1Therapies.js.

// ------------------------------------
// GET /api/glp1-reviews — List reviews
// ------------------------------------
// Authorization: Doctor, Staff
// Query: ?therapyId= or ?uhid= (one is required), ?includeDeleted=true
router.get(
  '/',
  authenticate,
  authorize('doctor', 'staff'),
  glp1ReviewController.list
);

// ------------------------------------
// POST /api/glp1-reviews — Record a monitoring visit
// ------------------------------------
// Authorization: Doctor only
router.post(
  '/',
  authenticate,
  authorize('doctor', 'staff'),
  [
    body('therapyId')
      .isInt({ min: 1 })
      .withMessage('A therapy must be selected'),
    body('weekNumber')
      .isInt({ min: 0 })
      .withMessage('Week number must be a whole number, 0 or greater'),
    body('reviewDate')
      .notEmpty()
      .withMessage('Review date is required')
      .isISO8601()
      .withMessage('Review date must be a valid date'),
    body('weight')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Weight must be greater than zero'),
    body('bmi')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('BMI must be greater than zero'),
    body('waistCircumference')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Waist circumference must be greater than zero'),
    body('bp')
      .optional({ nullable: true })
      .isString()
      .withMessage('Blood pressure must be a string like "128/80"'),
    body('heartRate')
      .optional({ nullable: true })
      .isInt({ min: 0 })
      .withMessage('Heart rate must be a whole number'),
    body('fpg')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('Fasting plasma glucose must be a number'),
    body('hba1c')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('HbA1c must be a number'),
    body('doseAtReview')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Dose at review must be greater than zero'),
    body('adherence')
      .optional({ nullable: true })
      .isIn(['Good', 'Missed doses', 'Stopped'])
      .withMessage('Adherence must be Good, Missed doses or Stopped'),
    body('actionPlan')
      .optional({ nullable: true })
      .isString()
      .withMessage('Action plan must be a string'),
    body('sideEffects')
      .optional()
      .isArray()
      .withMessage('Side effects must be an array'),
    validate,
  ],
  glp1ReviewController.create
);

// ------------------------------------
// PUT /api/glp1-reviews/:id — Amend a review
// ------------------------------------
// Authorization: Doctor only
// A reason is required every time, including on the day the review was written.
router.put(
  '/:id',
  authenticate,
  authorize('doctor', 'staff'),
  [
    body('amendmentReason')
      .trim()
      .notEmpty()
      .withMessage('A reason is required to amend a review'),
    body('reviewDate')
      .optional()
      .isISO8601()
      .withMessage('Review date must be a valid date'),
    body('weight')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Weight must be greater than zero'),
    body('bmi')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('BMI must be greater than zero'),
    body('waistCircumference')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Waist circumference must be greater than zero'),
    body('heartRate')
      .optional({ nullable: true })
      .isInt({ min: 0 })
      .withMessage('Heart rate must be a whole number'),
    body('fpg')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('Fasting plasma glucose must be a number'),
    body('hba1c')
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage('HbA1c must be a number'),
    body('doseAtReview')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Dose at review must be greater than zero'),
    body('adherence')
      .optional({ nullable: true })
      .isIn(['Good', 'Missed doses', 'Stopped'])
      .withMessage('Adherence must be Good, Missed doses or Stopped'),
    body('sideEffects')
      .optional()
      .isArray()
      .withMessage('Side effects must be an array'),
    validate,
  ],
  glp1ReviewController.amend
);

// ------------------------------------
// DELETE /api/glp1-reviews/:id — Remove a review from the record
// ------------------------------------
// Authorization: Doctor, Admin
// Soft delete: the row stays, status flips to 'deleted', and the week is freed.
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  [
    body('reason')
      .trim()
      .notEmpty()
      .withMessage('A reason is required to remove a review'),
    validate,
  ],
  glp1ReviewController.remove
);

module.exports = router;
