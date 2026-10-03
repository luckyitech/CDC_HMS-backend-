const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const selfLeave = require('../controllers/hrSelfLeaveController');
const selfProfile = require('../controllers/hrProfileController');
const cpd = require('../controllers/cpdController');
const staffPhoto = require('../controllers/staffPhotoController');
const hrRoster = require('../controllers/hrRosterController');
const { handlePhotoUpload } = require('../middleware/uploadStaffPhoto');

// =====================================================================
// HR Suite — my own record (B27 phase 2) — /api/hr/me
//
// SELF: every internal role by role (the list IS the default), plus hr.self so
// it can be granted or, more usefully, WITHDRAWN from one person (authorize
// checks a withdrawal first). Patients never pass.
//
// NO ROUTE HERE NAMES A PERSON. Everything acts on req.user.id — ownership is
// the query itself (`where: { id, UserId: req.user.id }` in the controller),
// so there is no "whose record" parameter to tamper with.
// tests/hrLeavePhase2.test.js enforces both.
//
// Mounted in app.js BEFORE /api/hr so /api/hr/me/* never reaches that router.
// =====================================================================
const SELF = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.self'];

const ID = param('id').isInt({ min: 1 }).withMessage('Unknown request');

const PARTS = [
  body('startPart').optional().isIn(['full', 'pm']).withMessage('Invalid start'),
  body('endPart').optional().isIn(['full', 'am']).withMessage('Invalid end'),
];

// ---- Leave ---------------------------------------------------------------------
router.get('/leave', authenticate, authorize(...SELF), [
  query('year').optional().isInt({ min: 2020, max: 2100 }), validate,
], selfLeave.overview);

router.post('/leave/preview', authenticate, authorize(...SELF), [...PARTS, validate], selfLeave.preview);

router.post('/leave', authenticate, authorize(...SELF), [
  body('leaveType').isString().trim().notEmpty().withMessage('Choose a leave type'),
  body('startDate').isISO8601({ strict: true }).withMessage('Choose the first day'),
  body('endDate').isISO8601({ strict: true }).withMessage('Choose the last day'),
  ...PARTS,
  body('participants').isArray({ min: 1, max: 12 }).withMessage('Add at least one approver'),
  body('reason').optional({ nullable: true }).isString(),
  body('reachable').optional({ nullable: true }).isBoolean(),
  body('contactNote').optional({ nullable: true }).isString(),
  body('excludeWeekends').optional().isBoolean(),
  validate,
], selfLeave.submit);

router.get('/leave/:id', authenticate, authorize(...SELF), [ID, validate], selfLeave.getOne);

router.post('/leave/:id/reply', authenticate, authorize(...SELF), [
  ID, body('note').isString().trim().notEmpty().withMessage('Write your answer'), validate,
], selfLeave.reply);

router.post('/leave/:id/withdraw', authenticate, authorize(...SELF), [ID, validate], selfLeave.withdraw);

router.post('/leave/:id/cancel-request', authenticate, authorize(...SELF), [ID, validate], selfLeave.cancelRequest);

router.patch('/leave/:id/attachment', authenticate, authorize(...SELF), [
  ID, body('documentId').isInt({ min: 1 }).withMessage('Choose the document'), validate,
], selfLeave.addAttachment);

// ---- My profile (phase 4) --------------------------------------------------------
// Contact details save directly; name, ID, date of birth, licence and
// qualification go as change requests HR decides (D11).
router.get('/', authenticate, authorize(...SELF), selfProfile.me);
router.patch('/contact', authenticate, authorize(...SELF), [
  body('phone').optional({ nullable: true }).isString(),
  body('address').optional({ nullable: true }).isString(),
  body('city').optional({ nullable: true }).isString(),
  body('emergencyContact').optional({ nullable: true }).isObject(),
  validate,
], selfProfile.saveContact);
router.get('/change-requests', authenticate, authorize(...SELF), selfProfile.myRequests);
router.post('/change-requests', authenticate, authorize(...SELF), [
  body('changes').isArray({ min: 1, max: 12 }).withMessage('Nothing to change'),
  body('reason').optional({ nullable: true }).isString(),   // required — the controller says so (REASON_REQUIRED)
  body('documentId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }).withMessage('Unknown document'),
  validate,
], selfProfile.createRequests);
router.post('/change-requests/:id/withdraw', authenticate, authorize(...SELF), [ID, validate], selfProfile.withdrawRequest);

// ---- CPD (phase 5) ---------------------------------------------------------------
// My own continuing professional development. Log it; edit or delete only while
// it is still pending HR's check. Counted per calendar year against a per-cadre
// target; the certificate is a normal self-upload StaffDocument.
router.get('/cpd', authenticate, authorize(...SELF), [
  query('year').optional().isInt({ min: 2020, max: 2100 }), validate,
], cpd.list);
router.post('/cpd', authenticate, authorize(...SELF), [
  body('title').isString().trim().notEmpty().withMessage('Give the activity a title'),
  body('date').isISO8601({ strict: true }).withMessage('Choose the date'),
  body('points').exists().withMessage('Give the points'),
  body('category').optional({ nullable: true }).isString(),
  body('provider').optional({ nullable: true }).isString(),
  body('documentId').optional({ nullable: true }).isInt({ min: 1 }),
  validate,
], cpd.create);
router.patch('/cpd/:id', authenticate, authorize(...SELF), [
  ID,
  body('title').isString().trim().notEmpty().withMessage('Give the activity a title'),
  body('date').isISO8601({ strict: true }).withMessage('Choose the date'),
  body('points').exists().withMessage('Give the points'),
  body('category').optional({ nullable: true }).isString(),
  body('provider').optional({ nullable: true }).isString(),
  body('documentId').optional({ nullable: true }).isInt({ min: 1 }),
  validate,
], cpd.update);
router.delete('/cpd/:id', authenticate, authorize(...SELF), [ID, validate], cpd.remove);

// ---- People to choose as approvers / acknowledgers -----------------------------
router.get('/approvers', authenticate, authorize(...SELF), selfLeave.approvers);

// ---- Photo (2 Oct 2026; D11 — saved directly, logged) ------------------------
router.get('/photo', authenticate, authorize(...SELF), staffPhoto.selfGet);
router.put('/photo', authenticate, authorize(...SELF), handlePhotoUpload, staffPhoto.selfPut);
router.delete('/photo', authenticate, authorize(...SELF), staffPhoto.selfDelete);

// ---- My shifts (HR Tier 3 Phase 4, RO-11): published only, next 14 days ----
router.get('/roster', authenticate, authorize(...SELF), hrRoster.mine);

module.exports = router;
