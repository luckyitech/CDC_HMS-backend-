const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const labTestController = require('../controllers/labTestController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Lab Test routes have specific role requirements based on the workflow:
//
// ORDER (POST):     Only DOCTORS can order lab tests
// LIST (GET):       LAB TECHS, DOCTORS, STAFF can view all tests
// PENDING (GET):    LAB TECHS need to see tests waiting for processing
// CRITICAL (GET):   LAB TECHS and DOCTORS need to monitor critical results
// UPDATE (PUT):     Only LAB TECHS can enter results and update status
// STATS (GET):      LAB TECHS need dashboard statistics
// DELETE (DELETE):  Only DOCTORS and ADMINS can delete tests

// ------------------------------------
// POST /api/lab-tests — Order a new lab test
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can order lab tests
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('testType')
      .notEmpty()
      .withMessage('Test type is required'),
    body('sampleType')
      .notEmpty()
      .withMessage('Sample type is required'),
    body('priority')
      .optional()
      .isIn(['Routine', 'Urgent', 'STAT'])
      .withMessage('Priority must be Routine, Urgent, or STAT'),
    validate,
  ],
  labTestController.create
);

// ------------------------------------
// POST /api/lab-tests/request — Create a multi-test lab REQUEST (one requisition)
// ------------------------------------
// Authorization: doctor OR nurse. This is the shared request form's endpoint.
// A nurse must name the doctor they are requesting on behalf of (enforced in the
// controller). Attribution (who raised it) is taken from the JWT.
router.post(
  '/request',
  authenticate,
  authorize('doctor', 'nurse'),
  [
    body('uhid').notEmpty().withMessage('Patient UHID is required'),
    body('tests').isArray({ min: 1 }).withMessage('At least one test is required'),
    body('priority').optional().isIn(['Routine', 'Urgent', 'STAT'])
      .withMessage('Priority must be Routine, Urgent, or STAT'),
    validate,
  ],
  labTestController.createRequest
);

// PUT /api/lab-tests/request/:requisitionNumber — edit a request in place
// (only while every row is still Pending). doctor OR nurse.
router.put(
  '/request/:requisitionNumber',
  authenticate,
  authorize('doctor', 'nurse'),
  [
    body('uhid').notEmpty().withMessage('Patient UHID is required'),
    body('tests').isArray({ min: 1 }).withMessage('At least one test is required'),
    validate,
  ],
  labTestController.updateRequest
);

// PUT /api/lab-tests/request/:requisitionNumber/cancel — soft-cancel a request.
router.put(
  '/request/:requisitionNumber/cancel',
  authenticate,
  authorize('doctor', 'nurse', 'admin'),
  [body('uhid').notEmpty().withMessage('Patient UHID is required'), validate],
  labTestController.cancelRequest
);

// ------------------------------------
// GET /api/lab-tests/stats — MUST be before /:id
// ------------------------------------
// Authorization: Lab technicians (for dashboard)
// Why before /:id? Express matches routes in order.
// If this was after /:id, "stats" would be treated as an ID!
router.get(
  '/stats',
  authenticate,
  authorize('lab', 'doctor', 'admin', 'lab.view'),
  labTestController.stats
);

// ------------------------------------
// GET /api/lab-tests/pending — Pending/In-Progress tests
// ------------------------------------
// Authorization: Lab technicians (primary users)
// Why? Lab techs need to see what tests are waiting to be processed
router.get(
  '/pending',
  authenticate,
  authorize('lab', 'lab.view'),
  labTestController.pending
);

// ------------------------------------
// GET /api/lab-tests/critical — Critical results
// ------------------------------------
// Authorization: Lab technicians and doctors
// Why? Both roles need to monitor critical values for urgent follow-up
router.get(
  '/critical',
  authenticate,
  authorize('lab', 'doctor', 'lab.view'),
  labTestController.critical
);

// ------------------------------------
// GET /api/lab-tests — List all lab tests
// ------------------------------------
// Authorization: Lab technicians, doctors, staff
// How filtering works:
// - Doctors can see all tests they ordered
// - Lab techs can see all tests (for processing)
// - Staff can see all tests (for administrative tasks)
router.get(
  '/',
  authenticate,
  authorize('lab', 'nurse', 'doctor', 'staff', 'admin', 'lab.view'),
  labTestController.list
);

// ------------------------------------
// GET /api/lab-tests/:id — Single lab test
// ------------------------------------
// Authorization: Lab technicians, doctors, staff
router.get(
  '/:id',
  authenticate,
  authorize('lab', 'nurse', 'doctor', 'staff', 'admin', 'lab.view'),
  labTestController.getOne
);

// ------------------------------------
// PUT /api/lab-tests/:id — Enter results / update status
// ------------------------------------
// Authorization: Lab technicians only
// Why? Only lab techs should enter test results and update status
// Common updates: Entering results, marking as "Completed"
router.put(
  '/:id',
  authenticate,
  authorize('lab', 'lab.write'),
  [
    // Optional validation - status must be valid if provided
    body('status')
      .optional()
      .isIn(['Pending', 'Sample Collected', 'In Progress', 'Completed', 'Cancelled'])
      .withMessage('Invalid status value'),
    body('sampleCollected')
      .optional()
      .isBoolean()
      .withMessage('sampleCollected must be true or false'),
    body('isCritical')
      .optional()
      .isBoolean()
      .withMessage('isCritical must be true or false'),
    body('reportGenerated')
      .optional()
      .isBoolean()
      .withMessage('reportGenerated must be true or false'),
    validate,
  ],
  labTestController.update
);

// ------------------------------------
// DELETE /api/lab-tests/:id — Delete lab test
// ------------------------------------
// Authorization: Doctor, Admin
// Why? Deleting medical records is serious - restrict to doctors and admins only
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  labTestController.destroy
);

module.exports = router;
