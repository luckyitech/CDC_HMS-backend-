const express = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const findPatient = require('../middleware/findPatient');
const logPatientAccess = require('../middleware/logPatientAccess');
const { PERMISSIONS } = require('../constants/permissions');
const glucose = require('../controllers/glucoseController');

// Glucose Management Centre — mounted by routes/patients.js at
//   /api/patients/:uhid/glucose
// (mergeParams so :uhid reaches findPatient), which gives every handler the
// same merge-aware patient resolution and access logging as the rest of the
// patient file, with nothing re-implemented here.
//
// AUTHORIZATION — mirrors the blood-sugar logbook routes one file up:
//   Read  (summary / meters / batches / targets): doctor, nurse, admin,
//         patient (own record — enforced in the controller), CLINICAL_VIEW.
//   Import / meter housekeeping: doctor, nurse, admin, CLINICAL_RECORD, and
//         patient (own meter, Phase 2 — the controller refuses a patient any
//         conflict override).
//   Exclude / restore a reading, set targets: doctor, admin.
// 'admin' is listed explicitly so the admin-capability bypass applies (A4).

const router = express.Router({ mergeParams: true });

const READ  = ['doctor', 'nurse', 'admin', 'patient', PERMISSIONS.CLINICAL_VIEW];
const WRITE = ['doctor', 'nurse', 'admin', 'patient', PERMISSIONS.CLINICAL_RECORD];
const CLINICIAN = ['doctor', 'admin'];

router.get('/summary', authenticate, authorize(...READ), findPatient, logPatientAccess('glucose'), glucose.summary);
router.get('/meters',  authenticate, authorize(...READ), findPatient, logPatientAccess('glucose'), glucose.listMeters);
router.get('/batches', authenticate, authorize(...READ), findPatient, logPatientAccess('glucose'), glucose.listBatches);
router.get('/targets', authenticate, authorize(...READ), findPatient, glucose.getTargets);

router.post('/meter/preflight', authenticate, authorize(...WRITE), findPatient, [
  body('serial').optional().isString(),
  body('name').optional().isString(),
  validate,
], glucose.preflight);

router.post('/meter/import', authenticate, authorize(...WRITE), findPatient, [
  body('device').isObject().withMessage('device is required'),
  // An empty array is a legitimate result — the meter had nothing new since
  // the last download (or holds nothing). The controller records the sync.
  body('readings').isArray().withMessage('readings must be an array'),
  body('readings.*.sequenceNumber').isInt({ min: 0 }).withMessage('sequenceNumber must be an integer'),
  body('readings.*.measuredAt').isString().withMessage('measuredAt must be YYYY-MM-DD HH:mm:ss'),
  body('readings.*.glucoseMgdl').isFloat({ min: 0 }).withMessage('glucoseMgdl must be a number'),
  body('link.action').optional().isIn(['link', 'reassign', 'share']),
  body('link.usedFromDate').optional({ values: 'falsy' }).isISO8601().withMessage('usedFromDate must be YYYY-MM-DD'),
  validate,
], glucose.importMeter);

router.put('/meter/readings/:id/exclude', authenticate, authorize(...CLINICIAN), findPatient, [
  body('reason').notEmpty().withMessage('A reason is required'),
  validate,
], glucose.excludeReading);
router.put('/meter/readings/:id/restore', authenticate, authorize(...CLINICIAN), findPatient, glucose.restoreReading);

router.put('/meters/:id/clock-corrected', authenticate, authorize(...WRITE), findPatient, glucose.meterClockCorrected);
router.put('/meters/:id/retire', authenticate, authorize(...CLINICIAN), findPatient, [
  body('reason').notEmpty().withMessage('A reason is required'),
  validate,
], glucose.retireMeter);

router.put('/targets', authenticate, authorize(...CLINICIAN), findPatient, [
  body('rationale').notEmpty().withMessage('A rationale is required'),
  validate,
], glucose.putTargets);

module.exports = router;
