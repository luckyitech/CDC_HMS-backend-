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

// =====================================================================
// HR Suite (B21) — /api/hr
//
// CHECKIN: every internal role by role (the list IS the default), plus the
//          capability so it can be granted or, more usefully, WITHDRAWN from
//          one person (authorize checks a withdrawal first).
// VIEW / WRITE: the admin role, admin.access (via the bypass), or a grant.
// CONFIG: settings and tag keys, like every other settings write.
// The vocabulary test derives ADMIN_ACCESS_COVERS from these lists.
// =====================================================================
const CHECKIN = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.checkin'];
const VIEW    = ['admin', 'hr.view'];
const WRITE   = ['admin', 'hr.write'];
const CONFIG  = ['admin', 'config.write'];

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
router.post('/attendance/manual', authenticate, authorize(...WRITE), [
  body('userId').isInt({ min: 1 }).withMessage('userId is required'),
  body('checkInAt').notEmpty().withMessage('checkInAt is required'),
  body('reason').isString().trim().isLength({ min: 3 }).withMessage('A reason is required'),
  validate,
], hrAttendance.manual);
router.get('/attendance/:id', authenticate, authorize(...CHECKIN), [param('id').isInt(), validate], hrAttendance.getOne);
router.patch('/attendance/:id', authenticate, authorize(...WRITE), [
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
router.put('/work-hours/:userId', authenticate, authorize(...WRITE), [param('userId').isInt(), validate], hrWorkHours.update);

// ---- Entrance tags -----------------------------------------------------------
router.get('/tags',          authenticate, authorize(...WRITE), hrTags.list);
router.get('/tags/new-key',  authenticate, authorize(...CONFIG), hrTags.newKey);
router.post('/tags',         authenticate, strictLimiter, authorize(...CONFIG), [
  body('uid').matches(HEX14).withMessage('The tag UID must be 14 hex characters'),
  body('key').matches(/^[0-9a-fA-F]{32}$/).withMessage('The tag key must be 32 hex characters'),
  body('label').isString().trim().notEmpty().withMessage('A label is required'),
  validate,
], hrTags.create);
router.patch('/tags/:id',     authenticate, authorize(...WRITE), [param('id').isInt(), validate], hrTags.update);
router.post('/tags/:id/test', authenticate, authorize(...WRITE), [param('id').isInt(), body('url').isString().notEmpty(), validate], hrTags.test);

// ---- Settings ----------------------------------------------------------------
router.get('/settings', authenticate, authorize(...VIEW),   hrSettings.get);
router.put('/settings', authenticate, authorize(...CONFIG), [
  body('autoCheckin').optional().isBoolean().toBoolean(),
  body('confirmCheckout').optional().isBoolean().toBoolean(),
  body('positiveFeedback').optional().isBoolean().toBoolean(),
  validate,
], hrSettings.update);

module.exports = router;
