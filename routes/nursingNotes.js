const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const nursingNoteController = require('../controllers/nursingNoteController');

// Nursing notes (DAR-format Kardex). The Nursing tab appears in every clinical
// portal, so the clinical roles that can see it can read and write. Finer-grained
// permissions come later.
const CLINICAL = ['doctor', 'staff', 'nurse', 'admin'];

// POST /api/nursing-notes — add one DAR entry
router.post(
  '/',
  authenticate,
  authorize(...CLINICAL),
  [
    body('uhid').notEmpty().withMessage('Patient UHID is required'),
    body('data').optional().isString(),
    body('action').optional().isString(),
    body('response').optional().isString(),
    validate,
  ],
  nursingNoteController.create
);

// GET /api/nursing-notes?uhid= — the patient's Kardex
router.get('/', authenticate, authorize(...CLINICAL), nursingNoteController.list);

// DELETE /api/nursing-notes/:id — soft delete (author or admin)
router.delete('/:id', authenticate, authorize(...CLINICAL), nursingNoteController.remove);

module.exports = router;
