const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const leaveSettings = require('../controllers/leaveSettingsController');
const leaveApproval = require('../controllers/leaveApprovalController');
const leaveCalendar = require('../controllers/leaveCalendarController');

// =====================================================================
// Leave (B27) — /api/leave
//
// Phase 1: HR's Leave settings — the yearly policy, leave types, public
// holidays and each person's entitlement. All of it is leave.policy (D8):
// the admin role, admin.access through the bypass, or a grant. What may be
// changed WHEN (a year that has ended is frozen, publish is one-way) is
// decided in the controller by utils/leavePolicyRules.
//
// Phase 3: the approvals inbox and the request an approver opens. Anyone of
// staff may be listed on a colleague's request (the applicant chooses — D5),
// so PARTICIPATE is every internal role by role, plus leave.approve /
// leave.manage for a grant. WHICH request someone may open or decide is the
// controller's (listed on it, or leave.manage; never your own).
// Applying for your own leave is /api/hr/me (routes/hrSelf.js).
//
// Phase 5: the team calendar — every internal role sees it (PARTICIPATE); the
// controller redacts the leave type for anyone without leave.manage (Sick is
// always "Away", other types only if HR ticked them).
// =====================================================================
const POLICY = ['admin', 'leave.policy'];
const PARTICIPATE = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'leave.approve', 'leave.manage'];

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

// ---- Team calendar (phase 5) -------------------------------------------------
router.get('/calendar', authenticate, authorize(...PARTICIPATE), [
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('cadre').optional().isString(),
  validate,
], leaveCalendar.calendar);

// ---- Approvals (phase 3) ----------------------------------------------------------
const REQUEST = param('id').isInt({ min: 1 }).withMessage('Unknown request');
router.get('/inbox', authenticate, authorize(...PARTICIPATE), [
  query('tab').optional().isIn(['waiting', 'decided', 'all']),
  query('year').optional().isInt({ min: 2020, max: 2100 }),
  validate,
], leaveApproval.inbox);
router.get('/inbox/count', authenticate, authorize(...PARTICIPATE), leaveApproval.inboxCount);
router.get('/requests/:id', authenticate, authorize(...PARTICIPATE), [REQUEST, validate], leaveApproval.getRequest);
router.post('/requests/:id/decide', authenticate, authorize(...PARTICIPATE), [
  REQUEST,
  body('decision').isIn(['approve', 'decline', 'info']).withMessage('Choose approve, decline or ask'),
  body('note').optional({ nullable: true }).isString(),
  body('charges').optional().isArray({ min: 1, max: 8 }),
  validate,
], leaveApproval.decide);
router.post('/requests/:id/cancel', authenticate, authorize(...PARTICIPATE), [
  REQUEST, body('note').optional({ nullable: true }).isString(), validate,
], leaveApproval.cancel);
router.get('/requests/:id/attachment', authenticate, authorize(...PARTICIPATE), [REQUEST, validate], leaveApproval.attachment);

// ---- Audit ---------------------------------------------------------------------
router.get('/changes', authenticate, authorize(...POLICY), leaveSettings.recentChanges);

module.exports = router;
