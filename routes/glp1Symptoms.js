const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { RECORD_READERS } = require('../constants/roles');
const glp1SymptomController = require('../controllers/glp1SymptomController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// LIST (GET):      DOCTORS and STAFF
// CREATE (POST):   DOCTORS and ADMINS — "Add symptom" lives in the doctor's
//                  tracker and only widens what can be recorded
// DELETE (DELETE): ADMINS only — retiring one narrows the list clinic-wide

// ------------------------------------
// GET /api/glp1-symptoms — The clinic symptom catalogue
// ------------------------------------
// Authorization: every Patient-File role (doctor, nurse, staff, admin)
// Query: ?active=false to include retired symptoms
router.get(
  '/',
  authenticate,
  authorize(...RECORD_READERS),
  glp1SymptomController.list
);

// ------------------------------------
// POST /api/glp1-symptoms — Add a symptom, clinic-wide
// ------------------------------------
// Authorization: Doctor, Admin
router.post(
  '/',
  authenticate,
  authorize('doctor', 'admin'),
  [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Symptom name is required')
      .isLength({ max: 100 })
      .withMessage('Symptom name must be 100 characters or fewer'),
    validate,
  ],
  glp1SymptomController.create
);

// ------------------------------------
// DELETE /api/glp1-symptoms/:id — Retire a symptom
// ------------------------------------
// Authorization: Admin only
// Sets isActive false. Reviews that recorded it keep their gradings.
router.delete(
  '/:id',
  authenticate,
  authorize('admin'),
  glp1SymptomController.retire
);

module.exports = router;
