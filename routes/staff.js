const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS, passesAdminGate, canEditPermissions, canViewConfidential } = require('../constants/permissions');
const { error } = require('../utils/response');
const findStaff = require('../middleware/findStaff');
const uploadStaffDocument = require('../middleware/uploadStaffDocument');
const { handlePhotoUpload } = require('../middleware/uploadStaffPhoto');
const staffPhotoController = require('../controllers/staffPhotoController');
const staffController = require('../controllers/staffController');
const leaveController = require('../controllers/leaveController');
const staffDocumentController = require('../controllers/staffDocumentController');
const cpdController = require('../controllers/cpdController');
const requiredApproverController = require('../controllers/requiredApproverController');

const EMPLOYMENT_STATUSES = ['Active', 'On Leave', 'Suspended', 'Resigned', 'Terminated'];
const EMPLOYMENT_TYPES    = ['Full-time', 'Part-time', 'Contract', 'Consultant', 'Locum', 'Temporary'];

// Leave (B27, D8). Recording on someone's behalf: leave.manage (phase 3 —
// deciding a request moved to /api/leave/requests/:id, where the approvers the
// applicant chose decide it). Entitlement: leave.policy. Both used to be
// users.write.
const LEAVE_MANAGE = ['admin', 'leave.manage'];

// The staff file, one capability per job (HR Tier 3 Phase 0, 2 Oct 2026).
// users.view / users.write carry all of these (constants/permissions BUNDLES),
// so nobody who held them loses anything.
const STAFF_VIEW   = ['admin', 'staff.view'];
const STAFF_EDIT   = ['admin', 'staff.edit'];
const STAFF_STATUS = ['admin', 'staff.status'];
const STAFF_DOCS   = ['admin', 'staff.documents'];
const EXPIRY_LIST  = ['admin', 'staff.view', 'hr.expiry.alerts'];
// The permission catalog: whoever opens a staff file sees its Permissions tab
// (read-only), and both kinds of grantor need it to edit. Not an authorize()
// list because hr.grant must never be satisfiable by admin.access.
const catalogReader = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.STAFF_VIEW) || canEditPermissions(req.user)) return next();
  return error(res, 'Access denied', 403);
};

// Lets a staff member reach their own record, and anyone who may view staff
// reach any record. Declared here rather than inside the controllers so the
// route file still says who may call each endpoint.
//
// "May view staff" is exactly what authorize('admin', 'staff.view') admits —
// the gate on the list this file is opened from — so whoever can see the
// directory can open a file, and nobody can open a file they could not list.
// (users.view carries staff.view, so it still opens files — HR Tier 3.)
// It used to test `role === 'admin'`, which refused a doctor holding
// admin.access (403 on every file but their own) while every WRITE on the same
// file already went through authorize('admin', 'users.write') and let them in.
const adminOrSelf = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.STAFF_VIEW)) return next();
  if (req.staffUser && req.staffUser.id === req.user.id) return next();
  return error(res, 'Access denied', 403);
};

// The leave list: adminOrSelf, plus anyone who may see everyone's leave
// (leave.view — carried by leave.manage) even without opening staff files.
// What a viewer without sick-leave details sees of someone else's sick leave
// is trimmed in the controller (health data, leave.sick).
const leaveViewOrSelf = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.LEAVE_VIEW)) return next();
  return adminOrSelf(req, res, next);
};

// Uploading a document: the person to their own file, or someone who manages
// colleagues' documents, or a confidential-drawer holder (filing a contract).
const documentUploader = (req, res, next) => {
  if (req.staffUser && req.staffUser.id === req.user.id) return next();
  if (passesAdminGate(req.user, PERMISSIONS.STAFF_DOCUMENTS)) return next();
  if (canViewConfidential(req.user)) return next();
  return error(res, 'Access denied', 403);
};

// Changing someone's permissions: a permissions administrator, or a holder of
// "Grant HR permissions" — whose changes the controller limits to HR controls
// (staffController.updatePermissions).
const permissionsEditor = (req, res, next) => {
  if (canEditPermissions(req.user)) return next();
  return error(res, 'Only a permissions administrator can change what other people can do', 403);
};

// Multer rejects an oversized or wrong-typed file by throwing, which Express
// surfaces as a generic 500. This turns it into the message the admin needs.
// A face is wanted wherever a name is shown: the staff directory (hr.view) as
// well as the staff file itself (staff.view or the person) — 2 Oct 2026.
const photoViewer = (req, res, next) => {
  if (passesAdminGate(req.user, PERMISSIONS.HR_VIEW)) return next();
  return adminOrSelf(req, res, next);
};


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

router.get('/expiring-licences', authenticate, authorize(...EXPIRY_LIST), staffController.expiringLicences);
router.get('/permissions/catalog', authenticate, catalogReader, staffController.permissionCatalog);
router.get('/', authenticate, authorize(...STAFF_VIEW), staffController.list);

// ============================================================
// Profile
// ============================================================

router.get('/:employeeId', authenticate, findStaff, adminOrSelf, staffController.getOne);

router.put('/:employeeId', authenticate, authorize(...STAFF_EDIT), findStaff, [
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

router.patch('/:employeeId/status', authenticate, authorize(...STAFF_STATUS), findStaff, [
  body('employmentStatus').isIn(EMPLOYMENT_STATUSES).withMessage('Invalid employment status'),
  validate,
], staffController.updateStatus);

// Granting is reserved to a PERMISSIONS ADMINISTRATOR (permissions.grant or the
// true admin account), not merely someone holding admin.access — otherwise the
// capability propagates on its own and can never be reliably revoked. Since HR
// Tier 3 a "Grant HR permissions" holder may also call it, for HR controls only.
router.patch('/:employeeId/permissions', authenticate, permissionsEditor, findStaff, [
  body('permissions').isArray().withMessage('Permissions must be a list'),
  // Optional so a caller that only grants leaves existing withdrawals alone;
  // see staffController.updatePermissions.
  body('deniedPermissions').optional().isArray().withMessage('Withdrawn permissions must be a list'),
  body('staffType').optional().isIn(['clinical', 'non_clinical']).withMessage('staffType must be clinical or non_clinical'),
  validate,
], staffController.updatePermissions);

router.delete('/:employeeId', authenticate, authorize(...STAFF_STATUS), findStaff, staffController.archive);
router.patch('/:employeeId/restore', authenticate, authorize(...STAFF_STATUS), findStaff, staffController.restore);

router.get('/:employeeId/activity', authenticate, authorize(...STAFF_VIEW), findStaff, [
  param('employeeId').notEmpty(),
  validate,
], staffController.activity);

// ============================================================
// Leave
// ============================================================

router.get('/:employeeId/leaves', authenticate, findStaff, leaveViewOrSelf, leaveController.list);
// Required approvers (HR Tier 2): read with the Leave tab; set by leave.required (Tier 3; leave.manage carries it), never on your own file.
router.get('/:employeeId/required-approvers', authenticate, findStaff, leaveViewOrSelf, requiredApproverController.list);
router.put('/:employeeId/required-approvers', authenticate, authorize('admin', 'leave.required'), findStaff, [
  body('approverIds').isArray({ max: 5 }).withMessage('Choose up to five people'), validate,
], requiredApproverController.set);

// Record on behalf (phase 3): leave.manage, approved on the spot. Never your
// own file — the controller refuses; your own leave goes through My leave.
// The leave type is checked against LeaveTypes in the controller.
const RECORD_FIELDS = [
  body('leaveType').isString().trim().notEmpty().withMessage('Leave type is required'),
  body('startDate').isISO8601({ strict: true }).withMessage('Valid start date is required'),
  body('endDate').isISO8601({ strict: true }).withMessage('Valid end date is required'),
  body('startPart').optional().isIn(['full', 'pm']).withMessage('Invalid start part'),
  body('endPart').optional().isIn(['full', 'am']).withMessage('Invalid end part'),
  body('reason').optional({ nullable: true }).isString(),
  body('excludeWeekends').optional().isBoolean(),
];
router.post('/:employeeId/leaves/preview', authenticate, authorize(...LEAVE_MANAGE), findStaff, [
  body('startPart').optional().isIn(['full', 'pm']), body('endPart').optional().isIn(['full', 'am']), validate,
], leaveController.previewOnBehalf);
router.post('/:employeeId/leaves', authenticate, authorize(...LEAVE_MANAGE), findStaff, [...RECORD_FIELDS, validate], leaveController.create);

// PUT /:employeeId/leave-balances was RETIRED (2 Oct 2026, B27 debt): no screen
// has used it since phase 3. Entitlement overrides are written in ONE place —
// Leave settings → Staff entitlements (PUT /api/leave/entitlements/:userId/:year,
// leaveService.saveOverrides).

// ============================================================
// Documents
// ============================================================

// Photo (2 Oct 2026).
router.get('/:employeeId/photo', authenticate, findStaff, photoViewer, staffPhotoController.staffGet);
router.put('/:employeeId/photo', authenticate, authorize(...STAFF_EDIT), findStaff, handlePhotoUpload, staffPhotoController.staffPut);
router.delete('/:employeeId/photo', authenticate, authorize(...STAFF_EDIT), findStaff, staffPhotoController.staffDelete);

// CPD, read-only, for the staff file's Credentials tab (B27 debt fix).
router.get('/:employeeId/cpd', authenticate, findStaff, adminOrSelf, cpdController.staffList);

router.get('/:employeeId/documents', authenticate, findStaff, adminOrSelf, staffDocumentController.list);

router.post('/:employeeId/documents', authenticate, findStaff, documentUploader,
  handleUpload, staffDocumentController.upload);

// Files stream through this authenticated route rather than the upload
// directory being served statically.
router.get('/:employeeId/documents/:id/file', authenticate, findStaff, adminOrSelf,
  staffDocumentController.serveFile);

router.patch('/:employeeId/documents/:id', authenticate, authorize(...STAFF_DOCS), findStaff,
  staffDocumentController.update);

// Archives rather than deletes — the file and the row both survive.
router.delete('/:employeeId/documents/:id', authenticate, authorize(...STAFF_DOCS), findStaff,
  staffDocumentController.archive);

router.patch('/:employeeId/documents/:id/restore', authenticate, authorize(...STAFF_DOCS), findStaff,
  staffDocumentController.restore);

module.exports = router;
// Exposed for tests/adminLiteralGates.test.js, which exercises the gate with a
// fake req/res and no database.
module.exports.adminOrSelf = adminOrSelf;
module.exports.leaveViewOrSelf = leaveViewOrSelf;
module.exports.documentUploader = documentUploader;
