const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const leaveSettings = require('../controllers/leaveSettingsController');

// =====================================================================
// Leave (B27) — /api/leave
//
// Phase 1: HR's Leave settings — the yearly policy, leave types, public
// holidays and each person's entitlement. All of it is leave.policy (D8):
// the admin role, admin.access through the bypass, or a grant. What may be
// changed WHEN (a year that has ended is frozen, publish is one-way) is
// decided in the controller by utils/leavePolicyRules.
//
// The application and approval routes (phases 2–3) join this file with their
// own gates.
// =====================================================================
const POLICY = ['admin', 'leave.policy'];

const YEAR = param('year').isInt({ min: 2020, max: 2100 }).withMessage('Choose a year');

// ---- Policy ----------------------------------------------------------------
router.get('/policies', authenticate, authorize(...POLICY), leaveSettings.listPolicies);
router.get('/policy/:year', authenticate, authorize(...POLICY), [YEAR, validate], leaveSettings.getPolicy);
router.put('/policy/:year', authenticate, authorize(...POLICY), [
  YEAR,
  body('weekWeights').isObject().withMessage('Each weekday needs a value'),
  body('types').optional().isObject(),
  body('visibleTypes').optional().isArray(),
  validate,
], leaveSettings.savePolicy);
router.post('/policy/:year/publish', authenticate, authorize(...POLICY), [YEAR, validate], leaveSettings.publishPolicy);
router.post('/policy/:year/copy-from/:prev', authenticate, authorize(...POLICY), [
  YEAR, param('prev').isInt({ min: 2020, max: 2100 }).withMessage('Choose the year to copy from'), validate,
], leaveSettings.copyPolicy);

// ---- Leave types -------------------------------------------------------------
router.get('/types', authenticate, authorize(...POLICY), leaveSettings.listTypes);
router.post('/types', authenticate, authorize(...POLICY), [
  body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Give the leave type a name'), validate,
], leaveSettings.createType);
router.patch('/types/:id', authenticate, authorize(...POLICY), [param('id').isInt(), validate], leaveSettings.updateType);

// ---- Public holidays ---------------------------------------------------------
router.get('/holidays', authenticate, authorize(...POLICY), [
  query('year').optional().isInt({ min: 2020, max: 2100 }), validate,
], leaveSettings.listHolidays);
router.post('/holidays', authenticate, authorize(...POLICY), [
  body('date').isISO8601().withMessage('Choose the date of the holiday'),
  body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Give the holiday a name'),
  validate,
], leaveSettings.createHoliday);
router.patch('/holidays/:id', authenticate, authorize(...POLICY), [param('id').isInt(), validate], leaveSettings.updateHoliday);

// ---- Entitlements ------------------------------------------------------------
router.get('/entitlements', authenticate, authorize(...POLICY), [
  query('year').optional().isInt({ min: 2020, max: 2100 }), validate,
], leaveSettings.entitlements);
router.put('/entitlements/:userId/:year', authenticate, authorize(...POLICY), [
  param('userId').isInt({ min: 1 }), YEAR,
  body('balances').optional().isArray(),
  body('reason').isString().trim().isLength({ min: 3 }).withMessage('Say why this person differs from the policy'),
  validate,
], leaveSettings.saveEntitlement);

// ---- Audit ---------------------------------------------------------------------
router.get('/changes', authenticate, authorize(...POLICY), leaveSettings.recentChanges);

module.exports = router;
