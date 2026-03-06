const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const physicalExamController = require('../controllers/physicalExamController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Physical Examination routes are doctor-only:
//
// CREATE (POST):     Only DOCTORS can create physical exams
// LIST (GET):        Only DOCTORS can view physical exams
// SINGLE (GET):      Only DOCTORS can view a single exam
// UPDATE (PUT):      Only DOCTORS can update exams
// DELETE (DELETE):   Only DOCTORS and ADMINS can delete exams

// ------------------------------------
// POST /api/physical-exams — Create new physical examination
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can perform and document physical examinations
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('examFindings').optional(),
    // Body system fields are optional - doctor may not examine all systems
    body('generalAppearance').optional(),
    body('cardiovascular').optional(),
    body('respiratory').optional(),
    body('gastrointestinal').optional(),
    body('neurological').optional(),
    body('musculoskeletal').optional(),
    body('skin').optional(),
    body('data')
      .optional()
      .isObject()
      .withMessage('Examination data must be a JSON object'),
    validate,
  ],
  physicalExamController.create
);

// ------------------------------------
// GET /api/physical-exams — List physical examinations
// ------------------------------------
// Authorization: Doctor
// REQUIRED query parameter: uhid (Patient UHID)
// OPTIONAL query parameter: search (searches across all fields)
// Example: GET /api/physical-exams?uhid=CDC001&search=cardiovascular
router.get(
  '/',
  authenticate,
  authorize('doctor', 'admin'),
  physicalExamController.list
);

// ------------------------------------
// GET /api/physical-exams/:id — Single physical examination
// ------------------------------------
// Authorization: Doctor
router.get(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  physicalExamController.getOne
);

// ------------------------------------
// PUT /api/physical-exams/:id — Update physical examination
// ------------------------------------
// Authorization: Doctor only
// Why? Only doctors should update medical examination records
// Automatically sets lastModified timestamp
router.put(
  '/:id',
  authenticate,
  authorize('doctor'),
  [
    // All fields are optional for updates
    body('generalAppearance').optional(),
    body('cardiovascular').optional(),
    body('respiratory').optional(),
    body('gastrointestinal').optional(),
    body('neurological').optional(),
    body('musculoskeletal').optional(),
    body('skin').optional(),
    body('examFindings').optional(),
    body('data')
      .optional()
      .isObject()
      .withMessage('Examination data must be a JSON object'),
    validate,
  ],
  physicalExamController.update
);

// ------------------------------------
// DELETE /api/physical-exams/:id — Delete physical examination
// ------------------------------------
// Authorization: Doctor, Admin
// Why? Deleting medical records is serious - restrict to doctors and admins only
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  physicalExamController.destroy
);

module.exports = router;
