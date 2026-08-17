const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { CLINICAL_READ_ROLES } = require('../constants/permissions');
const consultationNoteController = require('../controllers/consultationNoteController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// CREATE (POST):     Only DOCTORS can create consultation notes
// LIST / GET (GET):  Every internal role can read (read-only view in the
//                    patient file). Was doctor + staff, which meant admins and
//                    nurses got a 403 the frontend swallowed into a blank tab.
// UPDATE (PUT):      Only DOCTORS can edit their own notes
// DELETE (DELETE):   DOCTORS and ADMINS only

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
// Authorization: every internal role (read-only — enforced on frontend)
router.get(
  '/',
  authenticate,
  authorize(...CLINICAL_READ_ROLES),
  consultationNoteController.list
);

// ------------------------------------
// GET /api/consultation-notes/:id — Get single consultation note
// ------------------------------------
// Authorization: every internal role
router.get(
  '/:id',
  authenticate,
  authorize(...CLINICAL_READ_ROLES),
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
