const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const treatmentPlanController = require('../controllers/treatmentPlanController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Treatment Plan routes have specific role requirements:
//
// CREATE (POST):     Only DOCTORS can create treatment plans
// LIST (GET):        DOCTORS and STAFF can view treatment plans
// UPDATE (PUT):      Only DOCTORS can update treatment plan status
// DELETE (DELETE):   Only DOCTORS and ADMINS can delete treatment plans
// STATS (GET):       DOCTORS need dashboard statistics

// ------------------------------------
// POST /api/treatment-plans — Create new treatment plan
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can create treatment plans
// IMPORTANT: Creating a new plan auto-completes all other Active plans for that patient
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('diagnosis')
      .notEmpty()
      .withMessage('Diagnosis is required'),
    body('plan')
      .notEmpty()
      .withMessage('Treatment plan is required'),
    validate,
  ],
  treatmentPlanController.create
);

// ------------------------------------
// GET /api/treatment-plans/stats — MUST be before /:id
// ------------------------------------
// Authorization: Doctor (for dashboard)
// Why before /:id? Express matches routes in order.
router.get(
  '/stats',
  authenticate,
  authorize('doctor', 'admin'),
  treatmentPlanController.stats
);

// ------------------------------------
// GET /api/treatment-plans — List treatment plans
// ------------------------------------
// Authorization: Doctor, Staff
// REQUIRED query parameter: uhid (Patient UHID)
// Example: GET /api/treatment-plans?uhid=CDC001
router.get(
  '/',
  authenticate,
  authorize('doctor', 'staff', 'admin'),
  treatmentPlanController.list
);

// ------------------------------------
// GET /api/treatment-plans/:id — Single treatment plan
// ------------------------------------
// Authorization: Doctor, Staff
router.get(
  '/:id',
  authenticate,
  authorize('doctor', 'staff', 'admin'),
  treatmentPlanController.getOne
);

// ------------------------------------
// PUT /api/treatment-plans/:id/status — Update status
// ------------------------------------
// Authorization: Doctor only
// Why? Only doctors should change treatment plan status
// Common use: Marking a plan as "Completed"
router.put(
  '/:id/status',
  authenticate,
  authorize('doctor'),
  [
    // Validation
    body('status')
      .isIn(['Active', 'Completed'])
      .withMessage('Status must be Active or Completed'),
    validate,
  ],
  treatmentPlanController.updateStatus
);

// ------------------------------------
// DELETE /api/treatment-plans/:id — Delete treatment plan
// ------------------------------------
// Authorization: Doctor, Admin
// Why? Deleting medical records is serious - restrict to doctors and admins only
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  treatmentPlanController.destroy
);

module.exports = router;
