const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const findPatient = require('../middleware/findPatient');
const patientController     = require('../controllers/patientController');
const bloodSugarController  = require('../controllers/bloodSugarController');
const equipmentController   = require('../controllers/equipmentController');

// ------------------------------------
// POST /api/patients — create patient
// ------------------------------------
router.post('/', authenticate, authorize('staff', 'admin'), [
  body('firstName').notEmpty().withMessage('First name is required'),
  body('lastName').notEmpty().withMessage('Last name is required'),
  validate,
], patientController.create);

// ------------------------------------
// GET /api/patients/stats — MUST be before /:uhid so Express doesn't treat "stats" as a uhid
// ------------------------------------
router.get('/stats', authenticate, authorize('doctor', 'staff', 'admin'), patientController.stats);

// ------------------------------------
// GET /api/patients — list with filters
// ------------------------------------
router.get('/', authenticate, authorize('doctor', 'staff', 'admin'), patientController.list);

// ------------------------------------
// GET /api/patients/:uhid — single patient (all authenticated roles)
// ------------------------------------
router.get('/:uhid', authenticate, findPatient, patientController.getOne);

// ------------------------------------
// PUT /api/patients/:uhid — update patient
// ------------------------------------
router.put('/:uhid', authenticate, authorize('staff', 'admin'), findPatient, patientController.update);

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
  body('weight').isFloat().withMessage('Weight is required'),
  body('height').isFloat().withMessage('Height is required'),
  validate,
], patientController.recordVitals);

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
router.get('/:uhid/blood-sugar', authenticate, authorize('patient', 'doctor'), findPatient, bloodSugarController.get);

// ====================================
// MEDICAL EQUIPMENT ENDPOINTS
// ====================================

// ------------------------------------
// GET /api/patients/:uhid/equipment/history — MUST be before /:uhid/equipment/:id
// ------------------------------------
router.get('/:uhid/equipment/history', authenticate, authorize('doctor', 'staff'), equipmentController.getHistory);

// ------------------------------------
// GET /api/patients/:uhid/equipment — current equipment
// ------------------------------------
router.get('/:uhid/equipment', authenticate, authorize('doctor', 'staff'), equipmentController.getCurrent);

// ------------------------------------
// POST /api/patients/:uhid/equipment — add new equipment
// ------------------------------------
router.post('/:uhid/equipment', authenticate, authorize('doctor', 'staff'), [
  body('deviceType').isIn(['pump', 'transmitter']).withMessage('Device type must be pump or transmitter'),
  body('type').isIn(['new', 'replacement', 'loaner']).withMessage('Type must be new, replacement, or loaner'),
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
  body('type').isIn(['new', 'replacement', 'loaner']).withMessage('Type must be new, replacement, or loaner'),
  body('serialNo').notEmpty().withMessage('Serial number is required'),
  body('startDate').isDate().withMessage('Valid start date is required'),
  body('warrantyStartDate').isDate().withMessage('Valid warranty start date is required'),
  body('warrantyEndDate').isDate().withMessage('Valid warranty end date is required'),
  validate,
], equipmentController.replace);

// ------------------------------------
// PUT /api/patients/:uhid/equipment/:id — update equipment
// ------------------------------------
router.put('/:uhid/equipment/:id', authenticate, authorize('doctor', 'staff'), equipmentController.update);

module.exports = router;
