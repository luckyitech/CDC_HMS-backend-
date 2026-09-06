const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const logPatientAccess = require('../middleware/logPatientAccess');
const { PERMISSIONS } = require('../constants/permissions');
const neuropathy = require('../controllers/neuropathyController');

// Neuropathy Studio — the in-portal Vibrotherm Dx assessment.
//
// AUTHORIZATION
//   Capture (create / readings / complete): doctor, nurse, admin, or anyone
//     holding RADIOLOGY_WRITE — the same people who work the Radiology portal.
//   Read (list / get): doctor, nurse, admin, or CLINICAL_VIEW (patient-file
//     readers), access-logged like every other clinical read.
//   Cancel (soft-delete): doctor or admin only.
// 'admin' is listed explicitly so the admin-capability bypass applies (A4).

const WRITE = ['doctor', 'nurse', 'admin', PERMISSIONS.RADIOLOGY_WRITE];
const READ  = ['doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW];

// ------------------------------------
// POST /api/neuropathy — create a Draft study for a UHID
// ------------------------------------
router.post(
  '/',
  authenticate,
  authorize(...WRITE),
  [
    body('uhid').notEmpty().withMessage('Patient UHID is required'),
    body('studyDate').optional().isISO8601().withMessage('studyDate must be YYYY-MM-DD'),
    body('referral').optional().isString().withMessage('referral must be a string'),
    validate,
  ],
  neuropathy.create
);

// ------------------------------------
// GET /api/neuropathy — list (uhid=… | recent worklist)
// ------------------------------------
router.get('/', authenticate, authorize(...READ), logPatientAccess('neuropathy'), neuropathy.list);

// ------------------------------------
// GET /api/neuropathy/analytics/overview — cross-patient cohort analytics
// (live prospective PNS study). Doctor/admin only; aggregate, so NOT
// patient-access-logged. Declared BEFORE '/:id' so this two-segment path is
// never captured by the single-segment id param.
// ------------------------------------
router.get('/analytics/overview', authenticate, authorize('doctor', 'admin'), neuropathy.analyticsOverview);
router.get('/analytics/coverage', authenticate, authorize('doctor', 'admin'), neuropathy.analyticsCoverage);
router.get('/analytics/correlation', authenticate, authorize('doctor', 'admin'), neuropathy.analyticsCorrelation);
router.get('/analytics/longitudinal', authenticate, authorize('doctor', 'admin'), neuropathy.analyticsLongitudinal);

// ------------------------------------
// GET /api/neuropathy/:id — full study with readings
// ------------------------------------
router.get('/:id', authenticate, authorize(...READ), logPatientAccess('neuropathy'), neuropathy.getById);

// ------------------------------------
// PUT /api/neuropathy/:id/readings — upsert site readings (Draft only)
// ------------------------------------
router.put(
  '/:id/readings',
  authenticate,
  authorize(...WRITE),
  [
    body('readings').isArray({ min: 1 }).withMessage('readings must be a non-empty array'),
    body('readings.*.foot').isIn(['R', 'L']).withMessage('foot must be R or L'),
    body('readings.*.site').isString().notEmpty().withMessage('site is required'),
    body('readings.*.modality').isIn(['VPT', 'HOT', 'COLD', 'MONO']).withMessage('modality must be VPT, HOT, COLD or MONO'),
    body('readings.*.omitted').optional().isBoolean().withMessage('omitted must be boolean'),
    validate,
  ],
  neuropathy.saveReadings
);

// ------------------------------------
// PUT /api/neuropathy/:id/complete — grade server-side and lock
// ------------------------------------
router.put(
  '/:id/complete',
  authenticate,
  authorize(...WRITE),
  [
    body('remarks').optional().isString().withMessage('remarks must be a string'),
    body('impression').optional().isString().withMessage('impression must be a string'),
    validate,
  ],
  neuropathy.complete
);

// ------------------------------------
// PUT /api/neuropathy/:id/cancel — soft-delete with attribution
// ------------------------------------
router.put(
  '/:id/cancel',
  authenticate,
  authorize('doctor', 'admin'),
  [body('reason').optional().isString().withMessage('reason must be a string'), validate],
  neuropathy.cancel
);

// ------------------------------------
// PUT /api/neuropathy/:id/report-saved — record the report PDF was filed (once)
// ------------------------------------
router.put(
  '/:id/report-saved',
  authenticate,
  authorize(...WRITE),
  [body('documentId').optional({ nullable: true }).isInt().withMessage('documentId must be an integer'), validate],
  neuropathy.markReportSaved
);

module.exports = router;
