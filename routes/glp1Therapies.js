const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { RECORD_READERS } = require('../constants/roles');
const glp1TherapyController = require('../controllers/glp1TherapyController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST / FULL (GET):  DOCTORS and STAFF can read (staff = read-only patient profile view)
// CREATE (POST):      Only DOCTORS — starting a drug is a clinical act
// UPDATE (PUT/PATCH): Only DOCTORS, any doctor, not just the prescriber.
//                     A patient may be seen by whoever is on that day.
// STOP (POST):        Only DOCTORS, and it requires a written reason
//
// There is no DELETE. A course the patient actually took stays in the record.

// ------------------------------------
// GET /api/glp1-therapies — List a patient's courses
// ------------------------------------
// Authorization: every Patient-File role (doctor, nurse, staff, admin)
// Query: ?uhid= (required), ?status=Active
router.get(
  '/',
  authenticate,
  authorize(...RECORD_READERS),
  glp1TherapyController.list
);

// ------------------------------------
// GET /api/glp1-therapies/:id/full — Everything the Tools panel needs, in one request
// ------------------------------------
// Authorization: every Patient-File role (doctor, nurse, staff, admin)
// Declared before /:id-style routes so 'full' is never read as an id.
router.get(
  '/:id/full',
  authenticate,
  authorize(...RECORD_READERS),
  glp1TherapyController.getFull
);

// ------------------------------------
// POST /api/glp1-therapies — Start a patient on a GLP-1 agonist
// ------------------------------------
// Authorization: Doctor only
// Returns 422 if the safety screen is incomplete, or if a positive finding has
// no override reason. Field-level shape is checked here; the clinical rules live
// in utils/glp1Safety.
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('medicationName')
      .trim()
      .notEmpty()
      .withMessage('A medication must be selected'),
    body('startDate')
      .notEmpty()
      .withMessage('Start date is required')
      .isISO8601()
      .withMessage('Start date must be a valid date'),
    body('indication')
      .optional()
      .isIn(['T2DM', 'Obesity', 'Both'])
      .withMessage('Indication must be T2DM, Obesity or Both'),
    body('startingDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Starting dose must be greater than zero'),
    body('targetDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Target dose must be greater than zero'),
    body('otherConditions')
      .optional({ nullable: true })
      .isString()
      .withMessage('Other conditions must be a string'),
    body('baseline')
      .optional({ nullable: true })
      .isObject()
      .withMessage('Baseline must be a JSON object'),
    body('safetyScreen')
      .isObject()
      .withMessage('Safety screen is required before therapy can be started'),
    body('doseSchedule')
      .optional()
      .isArray()
      .withMessage('Dose schedule must be an array of steps'),
    body('reviewWeeks')
      .optional()
      .isArray()
      .withMessage('Review weeks must be an array of week numbers'),
    validate,
  ],
  glp1TherapyController.create
);

// ------------------------------------
// PUT /api/glp1-therapies/:id — Update a course
// ------------------------------------
// Authorization: Doctor only
router.put(
  '/:id',
  authenticate,
  authorize('doctor'),
  [
    body('indication')
      .optional()
      .isIn(['T2DM', 'Obesity', 'Both'])
      .withMessage('Indication must be T2DM, Obesity or Both'),
    body('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid date'),
    body('startingDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Starting dose must be greater than zero'),
    body('targetDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Target dose must be greater than zero'),
    body('otherConditions')
      .optional({ nullable: true })
      .isString()
      .withMessage('Other conditions must be a string'),
    body('baseline')
      .optional({ nullable: true })
      .isObject()
      .withMessage('Baseline must be a JSON object'),
    body('status')
      .optional()
      .isIn(['Active', 'Paused', 'Completed'])
      .withMessage('Status must be Active, Paused or Completed. Use /stop to stop a course.'),
    validate,
  ],
  glp1TherapyController.update
);

// ------------------------------------
// PATCH /api/glp1-therapies/:id/schedule — Add, edit or remove dose steps
// ------------------------------------
// Authorization: Doctor only
// The whole ladder is sent and validated together — a step only makes sense
// next to its neighbours, so gaps and overlaps are rejected.
router.patch(
  '/:id/schedule',
  authenticate,
  authorize('doctor'),
  [
    body('doseSchedule')
      .isArray({ min: 1 })
      .withMessage('Dose schedule must have at least one step'),
    validate,
  ],
  glp1TherapyController.updateSchedule
);

// ------------------------------------
// POST /api/glp1-therapies/:id/review-weeks — Add a monitoring week
// ------------------------------------
// Authorization: Doctor only
router.post(
  '/:id/review-weeks',
  authenticate,
  authorize('doctor'),
  [
    body('week')
      .isInt({ min: 1 })
      .withMessage('Review week must be a whole number greater than zero'),
    validate,
  ],
  glp1TherapyController.addReviewWeek
);

// ------------------------------------
// POST /api/glp1-therapies/:id/switch — Move to a different agent
// ------------------------------------
// Authorization: Doctor only — choosing the agent is a prescribing decision.
// Stops this course and starts the new one linked to it, in one transaction.
router.post(
  '/:id/switch',
  authenticate,
  authorize('doctor'),
  [
    body('medicationName')
      .trim()
      .notEmpty()
      .withMessage('Select the agent to switch to'),
    body('reason')
      .trim()
      .notEmpty()
      .withMessage('A reason is required to switch agents'),
    body('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid date'),
    body('startingDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Starting dose must be greater than zero'),
    body('targetDose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Target dose must be greater than zero'),
    body('doseSchedule')
      .optional()
      .isArray()
      .withMessage('Dose schedule must be an array of steps'),
    validate,
  ],
  glp1TherapyController.switchMedication
);

// ------------------------------------
// POST /api/glp1-therapies/:id/stop — Stop a course
// ------------------------------------
// Authorization: Doctor only
router.post(
  '/:id/stop',
  authenticate,
  authorize('doctor'),
  [
    body('reason')
      .trim()
      .notEmpty()
      .withMessage('A reason is required to stop a course'),
    validate,
  ],
  glp1TherapyController.stop
);

module.exports = router;
