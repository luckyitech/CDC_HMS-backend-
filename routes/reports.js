const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const reportController = require('../controllers/reportController');

// ====================================
// REPORTS API ROUTES
// ====================================
// All report endpoints require authentication
// Most reports are accessible by doctors and admins
// Some reports (like patient-specific) can be accessed by the patient themselves

// ------------------------------------
// GET /api/reports/types — Get available report types
// ------------------------------------
// Authorization: Doctor, Admin
router.get(
  '/types',
  authenticate,
  authorize('doctor', 'admin'),
  reportController.getReportTypes
);

// ------------------------------------
// GET /api/reports/glycemic — Glycemic control report
// ------------------------------------
// Authorization: Doctor, Admin, Patient (own data only)
// Query params: uhid (required), period (optional)
router.get(
  '/glycemic',
  authenticate,
  authorize('doctor', 'admin', 'patient'),
  reportController.getGlycemicReport
);

// ------------------------------------
// GET /api/reports/patient-summary — Patient summary report
// ------------------------------------
// Authorization: Doctor, Admin, Patient (own data only)
// Query params: uhid (required)
router.get(
  '/patient-summary',
  authenticate,
  authorize('doctor', 'admin', 'patient'),
  reportController.getPatientSummary
);

// ------------------------------------
// GET /api/reports/medication-adherence — Medication adherence report
// ------------------------------------
// Authorization: Doctor, Admin, Patient (own data only)
// Query params: uhid (required), period (optional)
router.get(
  '/medication-adherence',
  authenticate,
  authorize('doctor', 'admin', 'patient'),
  reportController.getMedicationAdherence
);

// ------------------------------------
// GET /api/reports/high-risk-patients — High risk patients list
// ------------------------------------
// Authorization: Doctor, Admin only
// Query params: limit (optional)
router.get(
  '/high-risk-patients',
  authenticate,
  authorize('doctor', 'admin'),
  reportController.getHighRiskPatients
);

// ------------------------------------
// GET /api/reports/clinic-overview — Clinic statistics overview
// ------------------------------------
// Authorization: Doctor, Admin only
// Query params: period (optional)
router.get(
  '/clinic-overview',
  authenticate,
  authorize('doctor', 'admin'),
  reportController.getClinicOverview
);

module.exports = router;
