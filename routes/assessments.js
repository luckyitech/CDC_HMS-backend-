const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const assessmentController = require('../controllers/assessmentController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Initial Assessment routes are doctor-only:
//
// CREATE (POST):     Only DOCTORS can create initial assessments
// LIST (GET):        DOCTORS and ADMINS can view assessments
// SINGLE (GET):      DOCTORS and ADMINS can view a single assessment
// UPDATE (PUT):      Only DOCTORS can update assessments
// DELETE (DELETE):   DOCTORS and ADMINS can delete assessments

// ------------------------------------
// POST /api/assessments — Create new initial assessment
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can perform and document initial patient assessments
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('hpi').optional(),
    body('ros').optional(),
    body('pastMedicalHistory').optional(),
    body('familyHistory').optional(),
    body('socialHistory').optional(),
    body('data')
      .optional()
      .isObject()
      .withMessage('Assessment data must be a JSON object'),
    validate,
  ],
  assessmentController.create
);

// ------------------------------------
// GET /api/assessments — List initial assessments
// ------------------------------------
// Authorization: Doctor, Admin
// REQUIRED query parameter: uhid (Patient UHID)
// Example: GET /api/assessments?uhid=CDC001&page=1&limit=20
router.get(
  '/',
  authenticate,
  authorize('doctor', 'admin'),
  assessmentController.list
);

// ------------------------------------
// GET /api/assessments/:id — Single initial assessment
// ------------------------------------
// Authorization: Doctor, Admin
router.get(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  assessmentController.getOne
);

// ------------------------------------
// PUT /api/assessments/:id — Update initial assessment
// ------------------------------------
// Authorization: Doctor only
// Why? Only doctors should update medical assessment records
router.put(
  '/:id',
  authenticate,
  authorize('doctor'),
  [
    // All fields are optional for updates
    body('hpi').optional(),
    body('ros').optional(),
    body('pastMedicalHistory').optional(),
    body('familyHistory').optional(),
    body('socialHistory').optional(),
    validate,
  ],
  assessmentController.update
);

// ------------------------------------
// DELETE /api/assessments/:id — Delete initial assessment
// ------------------------------------
// Authorization: Doctor, Admin
// Why? Deleting medical records is serious - restrict to doctors and admins only
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  assessmentController.destroy
);

module.exports = router;
