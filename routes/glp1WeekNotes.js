const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const logPatientAccess = require('../middleware/logPatientAccess');
const { INTERNAL_ROLES, PERMISSIONS } = require('../constants/permissions');
const CLINICAL_READ_ROLES = INTERNAL_ROLES;
const glp1WeekNoteController = require('../controllers/glp1WeekNoteController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST (GET):      Every internal role (renders in the patient file)
// CREATE (POST):   DOCTORS and STAFF — nurses add the injection note, doctors
//                  the clinical note. Both land in the same table.
// DELETE (DELETE): DOCTORS and STAFF — soft delete. Ownership is enforced in the
//                  controller: a nurse removes only their own note, a doctor any.

// ------------------------------------
// GET /api/glp1-week-notes — Per-week notes
// ------------------------------------
// Query: ?therapyId= or ?uhid= (one required), ?weekNumber=, ?includeDeleted=
router.get(
  '/',
  authenticate,
  authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW),
  logPatientAccess('glp1'),
  glp1WeekNoteController.list
);

// ------------------------------------
// POST /api/glp1-week-notes — Add a note to a week
// ------------------------------------
router.post(
  '/',
  authenticate,
  authorize('doctor', 'nurse', PERMISSIONS.GLP1_WRITE),
  [
    body('therapyId')
      .isInt({ min: 1 })
      .withMessage('A therapy must be selected'),
    body('weekNumber')
      .isInt({ min: 0 })
      .withMessage('Week number must be a whole number, 0 or greater'),
    body('body')
      .isString()
      .trim()
      .notEmpty()
      .withMessage('A note cannot be empty'),
    validate,
  ],
  glp1WeekNoteController.create
);

// ------------------------------------
// DELETE /api/glp1-week-notes/:id — Soft-delete a note
// ------------------------------------
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'nurse', PERMISSIONS.GLP1_WRITE),
  glp1WeekNoteController.remove
);

module.exports = router;
