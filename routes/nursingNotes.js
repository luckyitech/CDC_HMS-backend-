const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const logPatientAccess = require('../middleware/logPatientAccess');
const { PERMISSIONS } = require('../constants/permissions');
const nursingNoteController = require('../controllers/nursingNoteController');

// Nursing notes (DAR-format Kardex). The Nursing tab appears in every clinical
// portal, so the clinical roles that can see it can read and write. Finer-grained
// permissions come later.
// Reading the Kardex is clinical-record access; writing to it is clinical
// work. 'staff' is deliberately NOT here any more: it holds reception and
// administration as well as nurses, so naming it let the front desk read and
// delete nursing notes. Nurses reach both through the clinical capabilities,
// which they hold by being marked clinical.
const READ  = ['doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW];
const WRITE = ['doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_RECORD];

// POST /api/nursing-notes — add one DAR entry
router.post(
  '/',
  authenticate,
  authorize(...WRITE),
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
router.get('/', authenticate, authorize(...READ), logPatientAccess('nursing-notes'), nursingNoteController.list);

// DELETE /api/nursing-notes/:id — soft delete (author or admin)
router.delete('/:id', authenticate, authorize(...WRITE), nursingNoteController.remove);

module.exports = router;
