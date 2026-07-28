const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const findPatient = require('../middleware/findPatient');
const patientController          = require('../controllers/patientController');
const bloodSugarController       = require('../controllers/bloodSugarController');
const equipmentController        = require('../controllers/equipmentController');
const careLinkPartnerController  = require('../controllers/careLinkPartnerController');
const barcodeController          = require('../controllers/barcodeController');

// ------------------------------------
// POST /api/patients — create patient (full registration)
// ------------------------------------
router.post('/', authenticate, authorize('staff', 'admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  validate,
], patientController.create);

// ------------------------------------
// POST /api/patients/quick — minimal placeholder for phone bookings
// Only firstName + lastName required; no User login account created.
// ------------------------------------
router.post('/quick', authenticate, authorize('staff', 'admin', 'doctor'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('phone').notEmpty().withMessage('Phone number is required'),
  validate,
], patientController.quickCreate);

// ------------------------------------
// GET /api/patients/stats — MUST be before /:uhid so Express doesn't treat "stats" as a uhid
// ------------------------------------
router.get('/stats', authenticate, authorize('doctor', 'staff', 'admin'), patientController.stats);

// ------------------------------------
// GET /api/patients/check-id — MUST be before /:uhid
// Real-time duplicate check as staff types an ID number during registration.
// ------------------------------------
router.get('/check-id', authenticate, authorize('staff', 'admin'), patientController.checkIdNumber);

// ------------------------------------
// GET /api/patients/duplicates — admin: active patient pairs sharing same idNumber
// MUST be before /:uhid
// ------------------------------------
router.get('/duplicates', authenticate, authorize('admin'), patientController.getDuplicates);

// ------------------------------------
// POST /api/patients/merge — admin: merge one patient into another then deactivate
// MUST be before /:uhid
// ------------------------------------
router.post('/merge', authenticate, authorize('admin'), [
  body('keepUhid').notEmpty().withMessage('keepUhid is required'),
  body('discardUhid').notEmpty().withMessage('discardUhid is required'),
  validate,
], patientController.mergePatients);

// ------------------------------------
// GET /api/patients/scan/:payload — resolve a scanned barcode (merge-aware)
// MUST be before /:uhid so scan is not treated as a uhid.
// Lab included now so lab-side scanning needs no route change later.
// ------------------------------------
router.get('/scan/:payload', authenticate, authorize('staff', 'admin', 'doctor', 'lab'), barcodeController.resolveScan);

// ------------------------------------
// POST /api/patients/:uhid/barcode-email — email the patient their barcode card
// ------------------------------------
router.post('/:uhid/barcode-email', authenticate, authorize('staff', 'admin', 'doctor'), findPatient, barcodeController.emailBarcode);

// ------------------------------------
// PATCH /api/patients/:uhid/reactivate — admin: undo a merge and restore an inactive patient
// MUST be before /:uhid generic routes
// ------------------------------------
router.patch('/:uhid/reactivate', authenticate, authorize('admin'), patientController.reactivatePatient);

// ------------------------------------
// GET /api/patients — list with filters
// ------------------------------------
router.get('/', authenticate, authorize('doctor', 'staff', 'admin'), patientController.list);

// ------------------------------------
// GET /api/patients/:uhid — single patient (all authenticated roles)
// ------------------------------------
router.get('/:uhid', authenticate, findPatient, patientController.getOne);

// ------------------------------------
// POST /api/patients/:uhid/complete-registration
// Completes a quick-registered patient's profile and creates portal account.
// ------------------------------------
router.post('/:uhid/complete-registration', authenticate, authorize('staff', 'admin'), findPatient, patientController.completeRegistration);

// ------------------------------------
// PUT /api/patients/:uhid — update patient
// ------------------------------------
router.put('/:uhid', authenticate, authorize('staff', 'admin'), findPatient, patientController.update);

// ------------------------------------
// PATCH /api/patients/:uhid/summary — doctor writes/edits patient summary
// ------------------------------------
router.patch('/:uhid/summary', authenticate, authorize('doctor'), findPatient, patientController.updateSummary);

// ------------------------------------
// DELETE /api/patients/:uhid — delete patient
// ------------------------------------
router.delete('/:uhid', authenticate, authorize('admin'), findPatient, patientController.destroy);

// ------------------------------------
// POST /api/patients/:uhid/vitals — record triage vitals
// ------------------------------------
router.post('/:uhid/vitals', authenticate, authorize('staff'), findPatient, [
  body('bp').notEmpty().withMessage('Blood pressure is required'),
  body('heartRate').isInt().withMessage('Heart rate must be an integer'),
  body('weight').optional({ nullable: true }).isFloat().withMessage('Weight must be a number'),
  body('height').optional({ nullable: true }).isFloat().withMessage('Height must be a number'),
  validate,
], patientController.recordVitals);

// ------------------------------------
// POST /api/patients/:uhid/vitals/doctor — doctor records/completes vitals (all fields optional)
// ------------------------------------
router.post('/:uhid/vitals/doctor', authenticate, authorize('doctor'), findPatient, patientController.recordVitalsDoctor);

// ------------------------------------
// GET /api/patients/:uhid/vitals/history — all vitals records (MUST be before /:uhid/vitals)
// ------------------------------------
router.get('/:uhid/vitals/history', authenticate, authorize('doctor', 'staff'), findPatient, patientController.getVitalsHistory);

// ------------------------------------
// GET /api/patients/:uhid/vitals — latest vitals
// ------------------------------------
router.get('/:uhid/vitals', authenticate, authorize('doctor', 'staff'), findPatient, patientController.getVitals);

// ------------------------------------
// POST /api/patients/:uhid/blood-sugar — single or bulk reading (upsert)
// ------------------------------------
router.post('/:uhid/blood-sugar', authenticate, authorize('patient'), findPatient, [
  body('date').notEmpty().withMessage('Date is required'),
  validate,
], bloodSugarController.post);

// ------------------------------------
// GET /api/patients/:uhid/blood-sugar — readings with date filters
// ------------------------------------
router.get('/:uhid/blood-sugar', authenticate, authorize('patient', 'doctor', 'staff'), findPatient, bloodSugarController.get);

// ====================================
// MEDICAL EQUIPMENT ENDPOINTS
// ====================================

// ------------------------------------
// GET /api/patients/:uhid/equipment/history — MUST be before /:uhid/equipment/:id
// ------------------------------------
router.get('/:uhid/equipment/history',   authenticate, authorize('doctor', 'staff'), equipmentController.getHistory);

// ------------------------------------
// GET /api/patients/:uhid/equipment/audit-log — MUST be before /:uhid/equipment/:id
// ------------------------------------
router.get('/:uhid/equipment/audit-log', authenticate, authorize('doctor', 'staff'), equipmentController.getAuditLog);

// ------------------------------------
// GET /api/patients/:uhid/equipment — current equipment
// ------------------------------------
router.get('/:uhid/equipment', authenticate, authorize('doctor', 'staff'), equipmentController.getCurrent);

// ------------------------------------
// POST /api/patients/:uhid/equipment — add new equipment
// ------------------------------------
router.post('/:uhid/equipment', authenticate, authorize('doctor', 'staff'), [
  body('deviceType').isIn(['pump', 'transmitter']).withMessage('Device type must be pump or transmitter'),
  body('type').isIn(['new', 'pre-owned', 'replacement', 'upgrade']).withMessage('Invalid equipment type'),
  body('serialNo').notEmpty().withMessage('Serial number is required'),
  body('startDate').isDate().withMessage('Valid start date is required'),
  body('warrantyStartDate').isDate().withMessage('Valid warranty start date is required'),
  body('warrantyEndDate').isDate().withMessage('Valid warranty end date is required'),
  validate,
], equipmentController.add);

// ------------------------------------
// POST /api/patients/:uhid/equipment/:id/replace — replace equipment
// ------------------------------------
router.post('/:uhid/equipment/:id/replace', authenticate, authorize('doctor', 'staff'), [
  body('deviceType').isIn(['pump', 'transmitter']).withMessage('Device type must be pump or transmitter'),
  body('reason').notEmpty().withMessage('Reason for replacement is required'),
  body('type').isIn(['new', 'pre-owned', 'replacement', 'upgrade']).withMessage('Invalid equipment type'),
  body('serialNo').notEmpty().withMessage('Serial number is required'),
  body('startDate').isDate().withMessage('Valid start date is required'),
  body('warrantyStartDate').isDate().withMessage('Valid warranty start date is required'),
  body('warrantyEndDate').isDate().withMessage('Valid warranty end date is required'),
  validate,
], equipmentController.replace);

// ====================================
// CARELINK PARTNER ENDPOINTS
// ====================================

// ------------------------------------
// GET /api/patients/:uhid/carelink-partners
// ------------------------------------
router.get('/:uhid/carelink-partners', authenticate, authorize('doctor', 'staff'), careLinkPartnerController.getAll);

// ------------------------------------
// POST /api/patients/:uhid/carelink-partners
// ------------------------------------
router.post('/:uhid/carelink-partners', authenticate, authorize('doctor', 'staff'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('relationship').notEmpty().withMessage('Relationship is required'),
  validate,
], careLinkPartnerController.add);

// ------------------------------------
// PUT /api/patients/:uhid/carelink-partners/:id
// ------------------------------------
router.put('/:uhid/carelink-partners/:id', authenticate, authorize('doctor', 'staff'), careLinkPartnerController.update);

// ------------------------------------
// DELETE /api/patients/:uhid/carelink-partners/:id
// ------------------------------------
router.delete('/:uhid/carelink-partners/:id', authenticate, authorize('doctor', 'staff'), careLinkPartnerController.remove);

// ------------------------------------
// PUT /api/patients/:uhid/equipment/:id — update equipment
// ------------------------------------
router.put('/:uhid/equipment/:id', authenticate, authorize('doctor', 'staff'), equipmentController.update);

module.exports = router;
