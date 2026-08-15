const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { CLINICAL_READ_ROLES } = require('../constants/permissions');
const glp1AdministrationController = require('../controllers/glp1AdministrationController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST (GET):      Every internal role (renders in the patient file)
// RECORD (POST):   DOCTORS and STAFF — nurses give most weekly injections, so
//                  staff can record them. Staff still cannot start or stop a
//                  course; that stays a prescribing decision.
// DELETE (DELETE): DOCTORS and STAFF — removes a mis-keyed week

// ------------------------------------
// GET /api/glp1-administrations — Weekly injection record
// ------------------------------------
// Query: ?therapyId= or ?uhid= (one required), ?status=missed
router.get(
  '/',
  authenticate,
  authorize(...CLINICAL_READ_ROLES),
  glp1AdministrationController.list
);

// ------------------------------------
// POST /api/glp1-administrations — Record a week as given, missed or omitted
// ------------------------------------
// Recording the same week again updates it rather than duplicating.
router.post(
  '/',
  authenticate,
  authorize('doctor', 'staff'),
  [
    body('therapyId')
      .isInt({ min: 1 })
      .withMessage('A therapy must be selected'),
    body('weekNumber')
      .isInt({ min: 0 })
      .withMessage('Week number must be a whole number, 0 or greater'),
    body('status')
      .isIn(['given', 'missed', 'omitted'])
      .withMessage('Status must be given, missed or omitted'),
    body('administeredDate')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('Date must be a valid date'),
    body('dose')
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage('Dose must be greater than zero'),
    body('site')
      .optional({ nullable: true })
      .isString()
      .withMessage('Injection site must be a string'),
    body('note')
      .optional({ nullable: true })
      .isString()
      .withMessage('Note must be a string'),
    validate,
  ],
  glp1AdministrationController.record
);

// ------------------------------------
// DELETE /api/glp1-administrations/:id — Remove a week's record
// ------------------------------------
router.delete(
  '/:id',
  authenticate,
  authorize('doctor', 'staff'),
  glp1AdministrationController.remove
);

module.exports = router;
