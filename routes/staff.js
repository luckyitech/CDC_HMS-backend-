const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireTrueAdmin } = require('../middleware/auth');
const { PERMISSIONS, passesAdminGate } = require('../constants/permissions');
const { error } = require('../utils/response');
const findStaff = require('../middleware/findStaff');
const uploadStaffDocument = require('../middleware/uploadStaffDocument');
const staffController = require('../controllers/staffController');
const leaveController = require('../controllers/leaveController');
const staffDocumentController = require('../controllers/staffDocumentController');

const EMPLOYMENT_STATUSES = ['Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'];
const EMPLOYMENT_TYPES    = ['Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'];
const LEAVE_DECISIONS     = ['Approved', 'Rejected', 'Cancelled'];

// Leave (B27, D8). Deciding: leave.approve or leave.manage — who may decide
// WHICH request is checked inline (leaveController.canDecideLeaveFor: never
// your own; leave.approve only when you were listed as an approver).
// Entitlement: leave.policy. Both used to be users.write.
const LEAVE_DECIDE = ['admin', 'leave.approve', 'leave.manage'];
const LEAVE_POLICY = ['admin', 'leave.policy'];

// Lets a staff member reach their own record, and anyone who may view staff
// reach any record. Declared here rather than inside the controllers so the
// route file still says who may call each endpoint.
//
// "May view staff" is exactly what authorize('admin', 'users.view') admits —
// the gate on the list this file is opened from — so whoever can see the
// directory can open a file, and nobody can open a file they could not list.
// It used to test `role === 'admin'`, which refused a doctor holding
// admin.access (403 on every file but their own) while every WRITE on the same
// file already went through authorize('admin', 'users.write') and let them in.
const adminOrSelf = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.USERS_VIEW)) return next();
  if (req.staffUser && req.staffUser.id === req.user.id) return next();
  return error(res, 'Access denied', 403);
};

// The leave list and recording leave: adminOrSelf, plus a leave.manage holder
// (B27) — managing everyone's leave means opening anyone's leave tab, even
// without users.view. What a users.view-only viewer sees of someone else's
// sick leave is trimmed in the controller (health data).
const leaveViewOrSelf = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.LEAVE_MANAGE)) return next();
  return adminOrSelf(req, res, next);
};

// Multer rejects an oversized or wrong-typed file by throwing, which Express
// surfaces as a generic 500. This turns it into the message the admin needs.
const handleUpload = (req, res, next) =>
  uploadStaffDocument.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum size is 25MB.'
      : err.message || 'Upload failed';
    return res.status(400).json({ success: false, message });
  });

// ============================================================
// Collection routes
//
// These are declared before /:employeeId, otherwise Express matches their paths
// as an employee ID and findStaff returns 404.
// ============================================================

router.get('/expiring-licences', authenticate, authorize('admin', 'users.view'), staffController.expiringLicences);
router.get('/permissions/catalog', authenticate, authorize('admin', 'users.view'), staffController.permissionCatalog);
router.get('/', authenticate, authorize('admin', 'users.view'), staffController.list);

// ============================================================
// Profile
// ============================================================

router.get('/:employeeId', authenticate, findStaff, adminOrSelf, staffController.getOne);

router.put('/:employeeId', authenticate, authorize('admin', 'users.write'), findStaff, [
  body('firstName').optional().notEmpty().withMessage('First name cannot be empty'),
  body('lastName').optional().notEmpty().withMessage('Last name cannot be empty'),
  body('email').optional({ nullable: true }).isEmail().withMessage('Valid email is required'),
  body('gender').optional({ nullable: true, checkFalsy: true }).isIn(['Male', 'Female', 'Other']).withMessage('Invalid gender'),
  body('employmentType').optional({ nullable: true, checkFalsy: true }).isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  body('yearsExperience').optional({ nullable: true, checkFalsy: true }).isInt({ min: 0 }).withMessage('Years of experience must be a positive number'),
  body('emergencyContact').optional({ nullable: true }).isObject().withMessage('Emergency contact must be an object'),
  body('roleDetails').optional({ nullable: true }).isObject().withMessage('Role details must be an object'),
  validate,
], staffController.update);

router.patch('/:employeeId/status', authenticate, authorize('admin', 'users.write'), findStaff, [
  body('employmentStatus').isIn(EMPLOYMENT_STATUSES).withMessage('Invalid employment status'),
  validate,
], staffController.updateStatus);

// Granting is reserved to a real admin ACCOUNT, not merely someone holding
// admin.access — otherwise the capability propagates on its own and can never
// be reliably revoked. See middleware/auth.js.
router.patch('/:employeeId/permissions', authenticate, requireTrueAdmin, findStaff, [
  body('permissions').isArray().withMessage('Permissions must be a list'),
  // Optional so a caller that only grants leaves existing withdrawals alone;
  // see staffController.updatePermissions.
  body('deniedPermissions').optional().isArray().withMessage('Withdrawn permissions must be a list'),
  body('staffType').optional().isIn(['clinical', 'non_clinical']).withMessage('staffType must be clinical or non_clinical'),
  validate,
], staffController.updatePermissions);

router.delete('/:employeeId', authenticate, authorize('admin', 'users.write'), findStaff, staffController.archive);
router.patch('/:employeeId/restore', authenticate, authorize('admin', 'users.write'), findStaff, staffController.restore);

router.get('/:employeeId/activity', authenticate, authorize('admin', 'users.view'), findStaff, [
  param('employeeId').notEmpty(),
  validate,
], staffController.activity);

// ============================================================
// Leave
// ============================================================

router.get('/:employeeId/leaves', authenticate, findStaff, leaveViewOrSelf, leaveController.list);

// Staff may request their own leave; it is created Pending. A leave.manage
// holder's entry for someone else is approved immediately. The leave type is
// checked against LeaveTypes in the controller (it is data since B27).
router.post('/:employeeId/leaves', authenticate, findStaff, leaveViewOrSelf, [
  body('leaveType').isString().trim().notEmpty().withMessage('Leave type is required'),
  body('startDate').isISO8601({ strict: true }).withMessage('Valid start date is required'),
  body('endDate').isISO8601({ strict: true }).withMessage('Valid end date is required'),
  body('startPart').optional().isIn(['full', 'pm']).withMessage('Invalid start part'),
  body('endPart').optional().isIn(['full', 'am']).withMessage('Invalid end part'),
  body('reason').optional({ nullable: true }).isString(),
  body('excludeWeekends').optional().isBoolean(),
  validate,
], leaveController.create);

router.patch('/:employeeId/leaves/:id', authenticate, authorize(...LEAVE_DECIDE), findStaff, [
  body('status').isIn(LEAVE_DECISIONS).withMessage('Invalid decision'),
  body('decisionNote').optional({ nullable: true }).isString(),
  validate,
], leaveController.decide);

router.put('/:employeeId/leave-balances', authenticate, authorize(...LEAVE_POLICY), findStaff, [
  body('year').isInt({ min: 2000, max: 2100 }).toInt().withMessage('Invalid year'),
  body('balances').isArray({ min: 1 }).withMessage('Balances must be a non-empty list'),
  body('balances.*.leaveType').isString().trim().notEmpty().withMessage('Invalid leave type'),
  body('balances.*.entitled').optional({ nullable: true }).isFloat({ min: 0, max: 366 }).withMessage('Entitlement must be between 0 and 366 days'),
  body('balances.*.carriedOver').optional({ nullable: true }).isFloat({ min: 0, max: 366 }).withMessage('Carried-over days must be between 0 and 366'),
  body('reason').optional({ nullable: true }).isString(),
  validate,
], leaveController.setBalances);

// ============================================================
// Documents
// ============================================================

router.get('/:employeeId/documents', authenticate, findStaff, adminOrSelf, staffDocumentController.list);

router.post('/:employeeId/documents', authenticate, findStaff, adminOrSelf,
  handleUpload, staffDocumentController.upload);

// Files stream through this authenticated route rather than the upload
// directory being served statically.
router.get('/:employeeId/documents/:id/file', authenticate, findStaff, adminOrSelf,
  staffDocumentController.serveFile);

router.patch('/:employeeId/documents/:id', authenticate, authorize('admin', 'users.write'), findStaff,
  staffDocumentController.update);

// Archives rather than deletes — the file and the row both survive.
router.delete('/:employeeId/documents/:id', authenticate, authorize('admin', 'users.write'), findStaff,
  staffDocumentController.archive);

router.patch('/:employeeId/documents/:id/restore', authenticate, authorize('admin', 'users.write'), findStaff,
  staffDocumentController.restore);

module.exports = router;
// Exposed for tests/adminLiteralGates.test.js, which exercises the gate with a
// fake req/res and no database.
module.exports.adminOrSelf = adminOrSelf;
module.exports.leaveViewOrSelf = leaveViewOrSelf;
