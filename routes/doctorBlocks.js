const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
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
  authorize('doctor'),
  getUpcoming
);

// DELETE /api/doctor-blocks/date
router.delete(
  '/date',
  authenticate,
  authorize('doctor'),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    validate,
  ],
  clearDate
);

// GET /api/doctor-blocks?doctorId=X&date=YYYY-MM-DD
router.get(
  '/',
  authenticate,
  authorize('doctor', 'staff', 'admin', 'patient'),
  getBlocks
);

// POST /api/doctor-blocks/recurring
router.post(
  '/recurring',
  authenticate,
  authorize('doctor'),
  [
    body('fromDate').isDate().withMessage('Valid fromDate is required (YYYY-MM-DD)'),
    body('toDate').isDate().withMessage('Valid toDate is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    body('weekdays').optional().isArray(),
    validate,
  ],
  blockRecurring
);

// DELETE /api/doctor-blocks/recurring
router.delete(
  '/recurring',
  authenticate,
  authorize('doctor'),
  [
    body('fromDate').isDate().withMessage('Valid fromDate is required (YYYY-MM-DD)'),
    body('toDate').isDate().withMessage('Valid toDate is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    body('weekdays').optional().isArray(),
    validate,
  ],
  unblockRecurring
);

// POST /api/doctor-blocks/range
router.post(
  '/range',
  authenticate,
  authorize('doctor'),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 2 }).withMessage('At least 2 time slots are required'),
    validate,
  ],
  blockRange
);

// DELETE /api/doctor-blocks/range
router.delete(
  '/range',
  authenticate,
  authorize('doctor'),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlots').isArray({ min: 1 }).withMessage('At least 1 time slot is required'),
    validate,
  ],
  unblockRange
);

// POST /api/doctor-blocks — single slot or whole day
router.post(
  '/',
  authenticate,
  authorize('doctor'),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlot').optional().isString(),
    validate,
  ],
  block
);

// DELETE /api/doctor-blocks — single slot or whole day
router.delete(
  '/',
  authenticate,
  authorize('doctor'),
  [
    body('date').isDate().withMessage('Valid date is required (YYYY-MM-DD)'),
    body('timeSlot').optional().isString(),
    validate,
  ],
  unblock
);

module.exports = router;
