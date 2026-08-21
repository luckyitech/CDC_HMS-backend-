const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');
const glp1MedicationController = require('../controllers/glp1MedicationController');

// ====================================
// GLP-1 agents — read-only, derived from the clinic catalogue
// ====================================
// GLP-1 agents are catalogue medications (CatalogItem, type 'medication') tagged
// GLP-1 / GIP. Adding, editing and retiring them happens on the admin Clinical
// Catalog page, so there is no create/update/delete here — one place owns every
// medication decision in the app.

// ------------------------------------
// GET /api/glp1-medications — the agents that drive the medication tabs
// ------------------------------------
// Authorization: Doctor, Admin
router.get(
  '/',
  authenticate,
  authorize('doctor', 'admin'),
  glp1MedicationController.list
);

module.exports = router;
