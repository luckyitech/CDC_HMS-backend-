const express = require('express');
const router = express.Router();
const { query } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const analyticsController = require('../controllers/analyticsController');

const periodOptional = query('period')
  .optional()
  .isIn(['7days', '30days', '90days', '6months', '1year'])
  .withMessage('period must be one of: 7days, 30days, 90days, 6months, 1year');

// All analytics endpoints: admin only
router.get('/active-years',            authenticate, authorize('admin', 'monitoring.view'), analyticsController.getActiveYears);
router.get('/doctor-performance',      authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getDoctorPerformance);
router.get('/triage-metrics',          authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getTriageMetrics);
router.get('/consultation-timing',     authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getConsultationTiming);
router.get('/staff-triage-performance',authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getStaffTriagePerformance);
router.get('/triage-by-priority',      authenticate, authorize('admin', 'monitoring.view'), analyticsController.getTriageByPriority);
router.get('/length-of-stay',          authenticate, authorize('admin', 'monitoring.view'), analyticsController.getLengthOfStay);
router.get('/patient-volume-by-hour',  authenticate, authorize('admin', 'monitoring.view'), analyticsController.getPatientVolumeByHour);
router.get('/removal-reasons',         authenticate, authorize('admin', 'monitoring.view'), analyticsController.getRemovalReasons);
router.get('/wait-time-before-triage',              authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getWaitTimeBeforeTriage);
router.get('/wait-time-triage-to-consultation',     authenticate, authorize('admin', 'monitoring.view'), periodOptional, validate, analyticsController.getWaitTimeBetweenTriageAndConsultation);
router.get('/wait-time-consultation-to-billing',    authenticate, authorize('admin', 'monitoring.view'), analyticsController.getWaitTimeConsultationToBilling);

module.exports = router;
