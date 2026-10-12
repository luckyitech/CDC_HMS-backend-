const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');

// Blocking time: a doctor in their own diary (by role), or a holder of
// calendar.block in any doctor's diary, naming it with doctorId (12 Oct 2026).
const BLOCKERS = ['doctor', PERMISSIONS.CALENDAR_BLOCK];
const doctorIdField = () => body('doctorId').optional().isInt({ min: 1 }).withMessage('doctorId must be a doctor id');
const {
  block, unblock,
  getBlocks,
  blockRange, unblockRange,
  blockRecurring, unblockRecurring,
  getUpcoming, clearDate,
} = require('../controllers/doctorBlockController');

// GET /api/doctor-blocks/upcoming
router.get(
  '/upcoming',
  authenticate,
  authorize(...BLOCKERS),
  getUpcoming
);

// DELETE /api/doctor-blocks/date
router.delete(
  '/date',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    doctorIdField(),
    validate,
  ],
  clearDate
);

// GET /api/doctor-blocks?doctorId=X&date=YYYY-MM-DD
router.get(
  '/',
  authenticate,
  authorize('doctor', 'staff', 'admin', 'patient', 'appointments.view'),
  getBlocks
);

// POST /api/doctor-blocks/recurring
router.post(
  '/recurring',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('fromDate').isDate().withMessage('Valid fromDate is required (YYYY-MM-DD)'),
    body('toDate').isDate().withMessage('Valid toDate is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    body('weekdays').optional().isArray(),
    doctorIdField(),
    validate,
  ],
  blockRecurring
);

// DELETE /api/doctor-blocks/recurring
router.delete(
  '/recurring',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('fromDate').isDate().withMessage('Valid fromDate is required (YYYY-MM-DD)'),
    body('toDate').isDate().withMessage('Valid toDate is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    body('weekdays').optional().isArray(),
    doctorIdField(),
    validate,
  ],
  unblockRecurring
);

// POST /api/doctor-blocks/range
router.post(
  '/range',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 2 }).withMessage('At least 2 time slots are required'),
    doctorIdField(),
    validate,
  ],
  blockRange
);

// DELETE /api/doctor-blocks/range
router.delete(
  '/range',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    doctorIdField(),
    validate,
  ],
  unblockRange
);

// POST /api/doctor-blocks — single slot or whole day
router.post(
  '/',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlot').optional().isString(),
    doctorIdField(),
    validate,
  ],
  block
);

// DELETE /api/doctor-blocks — single slot or whole day
router.delete(
  '/',
  authenticate,
  authorize(...BLOCKERS),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlot').optional().isString(),
    doctorIdField(),
    validate,
  ],
  unblock
);

module.exports = router;
