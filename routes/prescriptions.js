const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const prescriptionController = require('../controllers/prescriptionController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Each route below has specific role requirements. Here's the logic:
//
// CREATE (POST):   Only DOCTORS can prescribe medications
// LIST (GET):      DOCTORS, STAFF, PATIENTS can view prescriptions
//                  (Patients can only see their own via filtering)
// STATS (GET):     DOCTORS and STAFF need dashboard statistics
// SINGLE (GET):    DOCTORS, STAFF, PATIENTS (same filtering logic)
// UPDATE (PUT):    Only DOCTORS can update prescription status
// DELETE (DELETE): Only DOCTORS and ADMINS can delete prescriptions

// ------------------------------------
// POST /api/prescriptions — Create new prescription
// ------------------------------------
// Authorization: Doctor only
// Why? Only licensed doctors can prescribe medications
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    // Validation rules - these run BEFORE the controller
    body('patientId')
      .isInt()
      .withMessage('Patient ID is required and must be a number'),
    body('diagnosis')
      .notEmpty()
      .withMessage('Diagnosis is required'),
    body('medications')
      .isArray({ min: 1 })
      .withMessage('At least one medication is required'),
    body('medications.*.name')
      .notEmpty()
      .withMessage('Medication name is required'),
    body('medications.*.dosage')
      .notEmpty()
      .withMessage('Dosage is required'),
    body('medications.*.frequency')
      .notEmpty()
      .withMessage('Frequency is required'),
    validate, // This middleware checks if validation failed
  ],
  prescriptionController.create
);

// ------------------------------------
// GET /api/prescriptions/stats — MUST be before /:id
// ------------------------------------
// Authorization: Doctor, Staff (for dashboards)
// Why before /:id? Express matches routes in order.
// If this was after /:id, "stats" would be treated as an ID!
router.get(
  '/stats',
  authenticate,
  authorize('doctor', 'staff', 'admin'),
  prescriptionController.stats
);

// ------------------------------------
// GET /api/prescriptions — List with filters
// ------------------------------------
// Authorization: Doctor, Staff, Patient
// How filtering works:
// - Doctors can see all prescriptions (for their patients)
// - Staff can see all (for pharmacy/admin tasks)
// - Patients can only see their own (enforced in controller via patientUhid filter)
router.get(
  '/',
  authenticate,
  authorize('doctor', 'staff', 'admin', 'patient'),
  prescriptionController.list
);

// ------------------------------------
// GET /api/prescriptions/:id — Single prescription
// ------------------------------------
// Authorization: Doctor, Staff, Patient
// Note: In a real system, you'd add middleware to check if:
// - Patient is viewing their own prescription
// - Doctor is viewing their patient's prescription
// For now, we trust the frontend to only request appropriate data
router.get(
  '/:id',
  authenticate,
  authorize('doctor', 'staff', 'admin', 'patient'),
  prescriptionController.getOne
);

// ------------------------------------
// PUT /api/prescriptions/:id — Update prescription
// ------------------------------------
// Authorization: Doctor only
// Why? Only doctors should change prescription status or details
// Common updates: Marking as "Completed" or "Cancelled"
router.put(
  '/:id',
  authenticate,
  authorize('doctor'),
  [
    // Optional validation - status must be valid if provided
    body('status')
      .optional()
      .isIn(['Active', 'Completed', 'Cancelled'])
      .withMessage('Status must be Active, Completed, or Cancelled'),
    validate,
  ],
  prescriptionController.update
);

// ------------------------------------
// DELETE /api/prescriptions/:id — Delete prescription
// ------------------------------------
// Authorization: Doctor, Admin
// Why? Deleting medical records is serious - restrict to doctors and admins only
// In production, consider soft-delete instead (marking as deleted without removing)
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'admin'),
  prescriptionController.destroy
);

module.exports = router;
