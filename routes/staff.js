const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireTrueAdmin } = require('../middleware/auth');
const findStaff = require('../middleware/findStaff');
const uploadStaffDocument = require('../middleware/uploadStaffDocument');
const staffController = require('../controllers/staffController');
const leaveController = require('../controllers/leaveController');
const staffDocumentController = require('../controllers/staffDocumentController');

const EMPLOYMENT_STATUSES = ['Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'];
const EMPLOYMENT_TYPES    = ['Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'];
const LEAVE_TYPES         = leaveController.LEAVE_TYPES;
const LEAVE_DECISIONS     = ['Approved', 'Rejected', 'Cancelled'];

// Lets a staff member reach their own record, and anyone with admin access
// reach any record. Declared here rather than inside the controllers so the
// route file still says who may call each endpoint.
const adminOrSelf = (req, res, next) => {
  if (req.user.role === 'admin') return next();
  if (req.staffUser && req.staffUser.id === req.user.id) return next();
  return res.status(403).json({ success: false, message: 'Access denied' });
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

router.get('/expiring-licences', authenticate, authorize('admin'), staffController.expiringLicences);
router.get('/permissions/catalog', authenticate, authorize('admin'), staffController.permissionCatalog);
router.get('/', authenticate, authorize('admin'), staffController.list);

// ============================================================
// Profile
// ============================================================

router.get('/:employeeId', authenticate, findStaff, adminOrSelf, staffController.getOne);

router.put('/:employeeId', authenticate, authorize('admin'), findStaff, [
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

router.patch('/:employeeId/status', authenticate, authorize('admin'), findStaff, [
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
  validate,
], staffController.updatePermissions);

router.delete('/:employeeId', authenticate, authorize('admin'), findStaff, staffController.archive);
router.patch('/:employeeId/restore', authenticate, authorize('admin'), findStaff, staffController.restore);

router.get('/:employeeId/activity', authenticate, authorize('admin'), findStaff, [
  param('employeeId').notEmpty(),
  validate,
], staffController.activity);

// ============================================================
// Leave
// ============================================================

router.get('/:employeeId/leaves', authenticate, findStaff, adminOrSelf, leaveController.list);

// Staff may request their own leave; it is created Pending. An admin's entry is
// approved immediately.
router.post('/:employeeId/leaves', authenticate, findStaff, adminOrSelf, [
  body('leaveType').isIn(LEAVE_TYPES).withMessage('Invalid leave type'),
  body('startDate').isISO8601().withMessage('Valid start date is required'),
  body('endDate').isISO8601().withMessage('Valid end date is required'),
  body('reason').optional({ nullable: true }).isString(),
  body('excludeWeekends').optional().isBoolean(),
  validate,
], leaveController.create);

router.patch('/:employeeId/leaves/:id', authenticate, authorize('admin'), findStaff, [
  body('status').isIn(LEAVE_DECISIONS).withMessage('Invalid decision'),
  body('decisionNote').optional({ nullable: true }).isString(),
  validate,
], leaveController.decide);

router.put('/:employeeId/leave-balances', authenticate, authorize('admin'), findStaff, [
  body('year').isInt({ min: 2000, max: 2100 }).withMessage('Invalid year'),
  body('balances').isArray({ min: 1 }).withMessage('Balances must be a non-empty list'),
  body('balances.*.leaveType').isIn(LEAVE_TYPES).withMessage('Invalid leave type'),
  body('balances.*.entitled').optional().isInt({ min: 0 }).withMessage('Entitlement must be a positive number'),
  body('balances.*.carriedOver').optional().isInt({ min: 0 }).withMessage('Carried-over days must be a positive number'),
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

router.patch('/:employeeId/documents/:id', authenticate, authorize('admin'), findStaff,
  staffDocumentController.update);

// Archives rather than deletes — the file and the row both survive.
router.delete('/:employeeId/documents/:id', authenticate, authorize('admin'), findStaff,
  staffDocumentController.archive);

router.patch('/:employeeId/documents/:id/restore', authenticate, authorize('admin'), findStaff,
  staffDocumentController.restore);

module.exports = router;
