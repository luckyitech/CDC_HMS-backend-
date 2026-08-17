const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { CLINICAL_READ_ROLES } = require('../constants/permissions');
const appointmentController = require('../controllers/appointmentController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Appointment routes have specific role requirements:
//
// BOOK (POST):        Patients (own), Doctors / Staff / Admin (on behalf of patient via uhid)
// LIST (GET):         PATIENTS (own only) plus every internal role
// UPDATE STATUS (PUT): STAFF, DOCTORS, PATIENTS can update status
// STATS (GET):        Only DOCTORS and ADMINS can view stats

// ------------------------------------
// GET /api/appointments/stats — Statistics
// ------------------------------------
router.get(
  '/stats',
  authenticate,
  authorize('doctor', 'admin'),
  appointmentController.stats
);

// ------------------------------------
// GET /api/appointments/slots?doctorId=X&date=YYYY-MM-DD
// Returns all time slots for a doctor on a date (free + booked)
// ------------------------------------
router.get(
  '/slots',
  authenticate,
  authorize('staff', 'doctor', 'admin'),
  appointmentController.getSlots
);

// ------------------------------------
// POST /api/appointments — Book appointment
// ------------------------------------
// Patients book for themselves.
// Doctors / staff / admin book on behalf of a patient by passing uhid.
router.post(
  '/',
  authenticate,
  authorize('patient', 'doctor', 'staff', 'admin'),
  [
    body('doctorId').isInt().withMessage('Doctor ID is required'),
    body('date').isDate().withMessage('Valid appointment date is required (YYYY-MM-DD)'),
    body('timeSlot').notEmpty().withMessage('Time slot is required'),
    body('appointmentType')
      .isIn(['consultation', 'follow-up', 'check-up', 'emergency'])
      .withMessage('Valid appointment type is required'),
    body('reason').notEmpty().withMessage('Reason for appointment is required'),
    body('uhid')
      .if((_, { req }) => req.user?.role !== 'patient')
      .notEmpty()
      .withMessage('Patient UHID is required'),
    body('notes').optional(),
    validate,
  ],
  appointmentController.book
);

// ------------------------------------
// GET /api/appointments — List appointments
// ------------------------------------
// Authorization: Patient (own) plus every internal role
// Patient role: Automatically filtered to their own appointments
// Optional query parameters: uhid, doctor, date, status
router.get(
  '/',
  authenticate,
  authorize(...CLINICAL_READ_ROLES, 'patient'),
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
