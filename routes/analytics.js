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
router.get('/active-years',            authenticate, authorize('admin'), analyticsController.getActiveYears);
router.get('/doctor-performance',      authenticate, authorize('admin'), periodOptional, validate, analyticsController.getDoctorPerformance);
router.get('/triage-metrics',          authenticate, authorize('admin'), periodOptional, validate, analyticsController.getTriageMetrics);
router.get('/consultation-timing',     authenticate, authorize('admin'), periodOptional, validate, analyticsController.getConsultationTiming);
router.get('/staff-triage-performance',authenticate, authorize('admin'), periodOptional, validate, analyticsController.getStaffTriagePerformance);
router.get('/triage-by-priority',      authenticate, authorize('admin'), analyticsController.getTriageByPriority);
router.get('/length-of-stay',          authenticate, authorize('admin'), analyticsController.getLengthOfStay);
router.get('/patient-volume-by-hour',  authenticate, authorize('admin'), analyticsController.getPatientVolumeByHour);
router.get('/removal-reasons',         authenticate, authorize('admin'), analyticsController.getRemovalReasons);

module.exports = router;
