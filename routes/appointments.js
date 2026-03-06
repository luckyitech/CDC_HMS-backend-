const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const appointmentController = require('../controllers/appointmentController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Appointment routes have specific role requirements:
//
// BOOK (POST):        Only PATIENTS can book appointments
// LIST (GET):         PATIENTS (own only), DOCTORS, STAFF can view
// UPDATE STATUS (PUT): STAFF, DOCTORS, PATIENTS can update status
// STATS (GET):        Only DOCTORS and ADMINS can view stats

// ------------------------------------
// GET /api/appointments/stats — Statistics
// ------------------------------------
// Authorization: Doctor, Admin
// IMPORTANT: This route MUST come before /:id routes
router.get(
  '/stats',
  authenticate,
  authorize('doctor', 'admin'),
  appointmentController.stats
);

// ------------------------------------
// POST /api/appointments — Book appointment
// ------------------------------------
// Authorization: Patient only
// Why? Only patients book their own appointments
router.post(
  '/',
  authenticate,
  authorize('patient'),
  [
    body('doctorId')
      .isInt()
      .withMessage('Doctor ID is required'),
    body('date')
      .isDate()
      .withMessage('Valid appointment date is required (YYYY-MM-DD)'),
    body('timeSlot')
      .notEmpty()
      .withMessage('Time slot is required'),
    body('appointmentType')
      .isIn(['consultation', 'follow-up', 'check-up', 'emergency'])
      .withMessage('Valid appointment type is required'),
    body('reason')
      .notEmpty()
      .withMessage('Reason for appointment is required'),
    body('notes')
      .optional(),
    validate,
  ],
  appointmentController.book
);

// ------------------------------------
// GET /api/appointments — List appointments
// ------------------------------------
// Authorization: Patient (own), Doctor, Staff
// Patient role: Automatically filtered to their own appointments
// Optional query parameters: uhid, doctor, date, status
router.get(
  '/',
  authenticate,
  authorize('patient', 'doctor', 'staff', 'admin'),
  appointmentController.list
);

// ------------------------------------
// PUT /api/appointments/:id/status — Update status
// ------------------------------------
// Authorization: Staff, Doctor, Patient
// Validation: Check-in requires appointment to be today and scheduled
router.put(
  '/:id/status',
  authenticate,
  authorize('staff', 'doctor', 'patient', 'admin'),
  [
    body('status')
      .isIn(['scheduled', 'checked-in', 'completed', 'cancelled'])
      .withMessage('Valid status is required'),
    validate,
  ],
  appointmentController.updateStatus
);

module.exports = router;
