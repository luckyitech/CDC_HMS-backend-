const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const consultationNoteController = require('../controllers/consultationNoteController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Consultation Notes are doctor-only:
//
// CREATE (POST):     Only DOCTORS can create consultation notes
// LIST (GET):        Only DOCTORS can view consultation notes

// ------------------------------------
// POST /api/consultation-notes — Create new consultation note
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can create clinical consultation notes
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules
    body('uhid')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('notes')
      .notEmpty()
      .withMessage('Consultation notes are required'),
    body('assessment')
      .optional()
      .isString()
      .withMessage('Clinical assessment must be a string'),
    body('plan')
      .optional()
      .isString()
      .withMessage('Treatment plan must be a string'),
    // Vitals should be a JSON object
    body('vitals')
      .optional()
      .isObject()
      .withMessage('Vitals must be a JSON object'),
    // PrescriptionIds should be an array if provided
    body('prescriptionIds')
      .optional()
      .isArray()
      .withMessage('Prescription IDs must be an array'),
    validate,
  ],
  consultationNoteController.create
);

// ------------------------------------
// GET /api/consultation-notes — List consultation notes
// ------------------------------------
// Authorization: Doctor only
// REQUIRED query parameter: uhid (Patient UHID)
// OPTIONAL query parameter: search (searches notes, assessment, plan)
// Example: GET /api/consultation-notes?uhid=CDC001&search=diabetes
router.get(
  '/',
  authenticate,
  authorize('doctor'),
  consultationNoteController.list
);

// ------------------------------------
// GET /api/consultation-notes/:id — Get single consultation note
// ------------------------------------
// Authorization: Doctor only
router.get(
  '/:id',
  authenticate,
  authorize('doctor'),
  consultationNoteController.getById
);

// ------------------------------------
// PUT /api/consultation-notes/:id — Update consultation note
// ------------------------------------
// Authorization: Doctor only (and only the doctor who created it)
router.put(
  '/:id',
  authenticate,
  authorize('doctor'),
  [
    // All fields are optional for update
    body('notes')
      .optional()
      .isString()
      .withMessage('Notes must be a string'),
    body('assessment')
      .optional()
      .isString()
      .withMessage('Assessment must be a string'),
    body('plan')
      .optional()
      .isString()
      .withMessage('Plan must be a string'),
    body('vitals')
      .optional()
      .isObject()
      .withMessage('Vitals must be a JSON object'),
    body('prescriptionIds')
      .optional()
      .isArray()
      .withMessage('Prescription IDs must be an array'),
    validate,
  ],
  consultationNoteController.update
);

// ------------------------------------
// DELETE /api/consultation-notes/:id — Delete consultation note
// ------------------------------------
// Authorization: Doctor only (and only the doctor who created it) or Admin
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  consultationNoteController.deleteNote
);

module.exports = router;
