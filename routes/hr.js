const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiter');
const rateLimit = require('express-rate-limit');
const hrAttendance = require('../controllers/hrAttendanceController');
const hrDevices = require('../controllers/hrDevicesController');
const hrWorkHours = require('../controllers/hrWorkHoursController');
const hrTags = require('../controllers/hrTagsController');
const hrSettings = require('../controllers/hrSettingsController');
const hrProfile = require('../controllers/hrProfileController');
const cpd = require('../controllers/cpdController');
const hrLists = require('../controllers/hrListsController');
const hrReports = require('../controllers/hrReportsController');

// =====================================================================
// HR Suite (B21) — /api/hr
//
// CHECKIN: every internal role by role (the list IS the default), plus the
//          capability so it can be granted or, more usefully, WITHDRAWN from
//          one person (authorize checks a withdrawal first).
// VIEW / WRITE: the admin role, admin.access (via the bypass), or a grant.
// SETTINGS: HR Suite settings and tag keys — hr.settings (B27, D8: every HR
//          function its own capability). Was config.write until B27.
// CPD_VERIFY: verify CPD — cpd.verify (was hr.credentials until HR Tier 3).
// AMEND / WORKHOURS / TAGS: the three halves of the old hr.write (HR Tier 3).
// The vocabulary test derives ADMIN_ACCESS_COVERS from these lists.
// =====================================================================
const CHECKIN = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.checkin'];
const VIEW    = ['admin', 'hr.view'];
// hr.write was split (HR Tier 3 Phase 0): a stored hr.write expands to all
// three (constants/permissions LEGACY_PERMISSIONS), so its holders keep them.
const AMEND     = ['admin', 'hr.attendance.amend'];
const WORKHOURS = ['admin', 'hr.workhours'];
const TAGS      = ['admin', 'hr.tags'];
const SETTINGS = ['admin', 'hr.settings'];
// Reading the settings: whoever sees attendance, and whoever may change them
// (B27 phase 1 — the Leave settings Alerts tab is hr.settings without hr.view).
const SETTINGS_READ = ['admin', 'hr.view', 'hr.settings'];
// Profile change requests (B27 phase 4, D11): deciding what colleagues ask to
// change on their own record. Never your own — the controller refuses.
const PROFILE_APPROVE = ['admin', 'hr.profile.approve'];
// CPD verification (B27 phase 5, D12). hr.credentials was split into
// cpd.verify and hr.expiry.alerts (HR Tier 3 Phase 0); a stored grant expands.
const CPD_VERIFY = ['admin', 'cpd.verify'];
// HR Tier 3 Phase 1: the Departments / Positions lists. Reading them is for
// every member of staff (pickers on the staff file, the wizard, the scope
// picker — department names are not secret); changing them is hr.lists.
const LISTS_READ = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.lists'];
const LISTS      = ['admin', 'hr.lists'];
// HR Tier 3 Phase 2 (T3-3, R-1): the Reports page and its downloads. Department
// scope applies (services/hrReports counts only the people in it).
const REPORTS = ['admin', 'hr.reports'];

// A tap is one request per person per event; 60 a minute per IP is generous
// for a whole clinic behind one NAT, and caps a scripted flood.
const tapLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many taps — wait a moment and tap again.' },
});

const HEX14 = /^[0-9a-fA-F]{14}$/, HEX6 = /^[0-9a-fA-F]{6}$/, HEX16 = /^[0-9a-fA-F]{16}$/;

// ---- Attendance: tap ---------------------------------------------------
router.post('/attendance/tap', authenticate, tapLimiter, authorize(...CHECKIN), [
  body('confirmToken').optional().isString(),
  body('uid').if(body('confirmToken').not().exists()).matches(HEX14).withMessage('uid must be 14 hex characters'),
  body('ctr').if(body('confirmToken').not().exists()).matches(HEX6).withMessage('ctr must be 6 hex characters'),
  body('cmac').if(body('confirmToken').not().exists()).matches(HEX16).withMessage('cmac must be 16 hex characters'),
  body('geo').optional({ nullable: true }).isObject(),
  validate,
], hrAttendance.tap);

// ---- Attendance: own record ------------------------------------------------
router.get('/attendance/me',         authenticate, authorize(...CHECKIN), hrAttendance.mine);
router.get('/attendance/me/summary', authenticate, authorize(...CHECKIN), [
  query('month').optional().matches(/^\d{4}-\d{2}$/).withMessage('month must be YYYY-MM'), validate,
], hrAttendance.mySummary);

// ---- Attendance: HR ---------------------------------------------------------
router.get('/attendance/today', authenticate, authorize(...VIEW), hrAttendance.today);
router.get('/attendance',       authenticate, authorize(...VIEW), hrAttendance.list);
router.post('/attendance/manual', authenticate, authorize(...AMEND), [
  body('userId').isInt({ min: 1 }).withMessage('userId is required'),
  body('checkInAt').notEmpty().withMessage('checkInAt is required'),
  body('reason').isString().trim().isLength({ min: 3 }).withMessage('A reason is required'),
  validate,
], hrAttendance.manual);
router.get('/attendance/:id', authenticate, authorize(...CHECKIN), [param('id').isInt(), validate], hrAttendance.getOne);
router.patch('/attendance/:id', authenticate, authorize(...AMEND), [
  param('id').isInt(),
  body('reason').isString().trim().isLength({ min: 3 }).withMessage('A reason is required'),
  validate,
], hrAttendance.amend);

// ---- Remembered phones -------------------------------------------------------
router.get('/devices/me',    authenticate, authorize(...CHECKIN), hrDevices.list);
router.delete('/devices/:id', authenticate, authorize(...CHECKIN), [param('id').isInt(), validate], hrDevices.revoke);

// ---- Working hours -----------------------------------------------------------
router.get('/work-hours',         authenticate, authorize(...VIEW), hrWorkHours.listAll);
router.get('/work-hours/me',      authenticate, authorize(...CHECKIN), hrWorkHours.mine);
router.put('/work-hours/:userId', authenticate, authorize(...WORKHOURS), [param('userId').isInt(), validate], hrWorkHours.update);

// ---- Entrance tags -----------------------------------------------------------
router.get('/tags',          authenticate, authorize(...TAGS), hrTags.list);
router.get('/tags/new-key',  authenticate, authorize(...SETTINGS), hrTags.newKey);
router.post('/tags',         authenticate, strictLimiter, authorize(...SETTINGS), [
  body('uid').matches(HEX14).withMessage('The tag UID must be 14 hex characters'),
  body('key').matches(/^[0-9a-fA-F]{32}$/).withMessage('The tag key must be 32 hex characters'),
  body('label').isString().trim().notEmpty().withMessage('A label is required'),
  validate,
], hrTags.create);
router.patch('/tags/:id',     authenticate, authorize(...TAGS), [param('id').isInt(), validate], hrTags.update);
router.post('/tags/:id/test', authenticate, authorize(...TAGS), [param('id').isInt(), body('url').isString().notEmpty(), validate], hrTags.test);

// ---- Settings ----------------------------------------------------------------
router.get('/settings', authenticate, authorize(...SETTINGS_READ), hrSettings.get);
router.put('/settings', authenticate, authorize(...SETTINGS), [
  body('autoCheckin').optional().isBoolean().toBoolean(),
  body('confirmCheckout').optional().isBoolean().toBoolean(),
  body('positiveFeedback').optional().isBoolean().toBoolean(),
  validate,
], hrSettings.update);

// ---- Profile change requests (B27 phase 4) ------------------------------------
router.get('/change-requests', authenticate, authorize(...PROFILE_APPROVE), [
  query('status').optional().isIn(['pending', 'decided']), validate,
], hrProfile.hrList);
router.get('/change-requests/count', authenticate, authorize(...PROFILE_APPROVE), hrProfile.hrCount);
router.get('/change-requests/:id/attachment', authenticate, authorize(...PROFILE_APPROVE), [param('id').isInt({ min: 1 }), validate], hrProfile.hrAttachment);
router.patch('/change-requests/:id', authenticate, authorize(...PROFILE_APPROVE), [
  param('id').isInt({ min: 1 }),
  body('decision').isIn(['approve', 'reject']).withMessage('Choose approve or reject'),
  body('note').optional({ nullable: true }).isString(),
  validate,
], hrProfile.hrDecide);

// ---- CPD verification (B27 phase 5; cpd.verify since HR Tier 3) ---------------
router.get('/cpd', authenticate, authorize(...CPD_VERIFY), [
  query('status').optional().isIn(['pending', 'decided']),
  query('year').optional().isInt({ min: 2020, max: 2100 }),
  validate,
], cpd.hrList);
router.get('/cpd/count', authenticate, authorize(...CPD_VERIFY), cpd.hrCount);
router.patch('/cpd/:id/verify', authenticate, authorize(...CPD_VERIFY), [
  param('id').isInt({ min: 1 }),
  body('decision').isIn(['verify', 'reject']).withMessage('Choose verify or reject'),
  body('points').optional({ nullable: true }),
  body('note').optional({ nullable: true }).isString(),
  validate,
], cpd.verify);
router.get('/cpd/:id/certificate', authenticate, authorize(...CPD_VERIFY), [param('id').isInt({ min: 1 }), validate], cpd.certificate);

// ---- Departments and positions (HR Tier 3 Phase 1) ----
const LIST = param('list').isIn(['departments', 'positions']).withMessage('Unknown list');
router.get('/lists', authenticate, authorize(...LISTS_READ), hrLists.list);
router.get('/lists/tidy', authenticate, authorize(...LISTS), hrLists.tidy);
router.post('/lists/tidy', authenticate, authorize(...LISTS), [
  body('departments').optional().isArray(), body('positions').optional().isArray(), validate,
], hrLists.applyTidy);
router.post('/lists/:list', authenticate, authorize(...LISTS), [
  LIST, body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Give it a name'), validate,
], hrLists.create);
router.patch('/lists/:list/:id', authenticate, authorize(...LISTS), [LIST, param('id').isInt({ min: 1 }), validate], hrLists.update);

// ---- HR reports (HR Tier 3 Phase 2) ----
const REPORT_QUERY = [
  query('year').optional().isInt({ min: 2020, max: 2100 }),
  query('month').optional().matches(/^\d{4}-\d{2}$/).withMessage('month must be YYYY-MM'),
  query('window').optional().isInt({ min: 1, max: 3650 }),
];
router.get('/reports', authenticate, authorize(...REPORTS), [...REPORT_QUERY, validate], hrReports.page);
router.get('/reports/:report/download', authenticate, authorize(...REPORTS), [
  param('report').isIn(hrReports.REPORTS).withMessage('Unknown report'), ...REPORT_QUERY, validate,
], hrReports.download);

module.exports = router;
