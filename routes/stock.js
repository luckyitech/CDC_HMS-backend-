const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { PERMISSIONS, CLINICAL_READ_ROLES } = require('../constants/permissions');

// The stock module's capability. Was a bespoke authorizeStock middleware reading
// a dedicated boolean column; now one of the generic per-user permissions.
const authorizeStock = requirePermission(PERMISSIONS.STOCK_MANAGE);
const catalog = require('../controllers/stockCatalogController');
const movements = require('../controllers/stockMovementController');
const rooms = require('../controllers/stockRoomController');
const reports = require('../controllers/stockReportController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Everything here requires authentication. Beyond that:
//   authorizeStock  — admins (implicitly), plus anyone granted the
//                     'stock.manage' permission. Read from the DB on every
//                     request, so a grant or revoke takes effect without
//                     re-login. Hiding the sidebar link is UX; THIS is the
//                     security boundary.
//   POST /use       — the one exception: point-of-care usage recording is
//                     open to all clinical roles. Gating it would guarantee
//                     unrecorded usage and rotten room counts.
//   POST /levels/rebuild — admin only (destructive recompute).

const qty = () => body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a whole number of at least 1');

// ---------- Reference data ----------
router.get('/items',        authenticate, authorizeStock, catalog.listItems);
router.post('/items',       authenticate, authorizeStock, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createItem);
router.put('/items/:id',    authenticate, authorizeStock, catalog.updateItem);

router.get('/locations',     authenticate, authorizeStock, catalog.listLocations);
router.post('/locations',    authenticate, authorizeStock, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createLocation);
router.put('/locations/:id', authenticate, authorizeStock, catalog.updateLocation);

router.get('/suppliers',     authenticate, authorizeStock, catalog.listSuppliers);
router.post('/suppliers',    authenticate, authorizeStock, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createSupplier);
router.put('/suppliers/:id', authenticate, authorizeStock, catalog.updateSupplier);

// ---------- Ledger writes (each one DB transaction with row locks) ----------
router.post('/intake', authenticate, authorizeStock, [
  body('stockItemId').isInt().withMessage('stockItemId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  qty(),
  validate,
], movements.intake);

router.post('/dispense', authenticate, authorizeStock, [
  body('locationId').isInt().withMessage('locationId is required'),
  qty(),
  validate,
], movements.dispense);

// Point-of-care use — clinical roles, NOT authorizeStock (see header note).
router.post('/use', authenticate, authorize('doctor', 'staff', 'admin'), [
  body('locationId').isInt().withMessage('locationId is required'),
  qty(),
  validate,
], movements.use);

// FEFO suggestion for the checkout nudge — clinical/reception roles.
router.get('/fefo-suggestion', authenticate, authorize('doctor', 'staff', 'admin'), movements.fefoSuggestion);

// A patient's dispensing history — patient-care context, every internal role
// (exposes only this patient's own rows), not authorizeStock. It renders inside
// the patient file's Visit History, so it follows the patient-record read list
// rather than the stock capability.
router.get('/patient-dispenses', authenticate, authorize(...CLINICAL_READ_ROLES), movements.patientDispenses);

// Checkout dispense — reception dispenses the supplies scanned on a patient's
// discharge charge sheet, patient-linked, in one transaction. Clinical/
// reception roles, NOT authorizeStock (same rationale as /use).
router.post('/checkout-dispense', authenticate, authorize('doctor', 'staff', 'admin'), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('lines').isArray({ min: 1 }).withMessage('At least one supply line is required'),
  validate,
], movements.checkoutDispense);

// Returns — a patient brings stock back. Patient-linked (recall traceability),
// reason required. Clinical/reception roles, NOT authorizeStock (same rationale
// as /use and /checkout-dispense).
router.post('/return', authenticate, authorize('doctor', 'staff', 'admin'), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('reason').notEmpty().withMessage('A reason is required'),
  qty(),
  validate,
], movements.returnStock);

// Whether a scanned batch was ever returned (and why) — drives the dispense
// warning. Clinical/reception roles.
router.get('/batches/:id/return-info', authenticate, authorize('doctor', 'staff', 'admin'), movements.batchReturnInfo);

router.post('/transfer', authenticate, authorizeStock, [
  body('fromLocationId').isInt().withMessage('fromLocationId is required'),
  body('toLocationId').isInt().withMessage('toLocationId is required'),
  qty(),
  validate,
], movements.transfer);

router.post('/adjustment', authenticate, authorizeStock, [
  body('stockBatchId').isInt().withMessage('stockBatchId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for adjustments'),
  qty(),
  validate,
], movements.adjustment);

router.post('/writeoff', authenticate, authorizeStock, [
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for write-offs'),
  qty(),
  validate,
], movements.writeoff);

router.post('/movements/:id/reverse', authenticate, authorizeStock, [
  body('reason').notEmpty().withMessage('A reason is required to reverse a movement'),
  validate,
], movements.reverse);

// ---------- Reads ----------
router.get('/movements', authenticate, authorizeStock, movements.listMovements);
router.get('/levels',    authenticate, authorizeStock, movements.listLevels);
router.get('/batches',   authenticate, authorizeStock, movements.listBatches);
router.get('/dashboard', authenticate, authorizeStock, movements.dashboard);

// Record-Use options — clinical roles, NOT authorizeStock (matches POST /use):
// only what point-of-care recording needs, nothing more.
router.get('/use-options', authenticate, authorize('doctor', 'staff', 'admin'), movements.useOptions);

// ---------- Room balancing (par levels, RAG grid, restock, stocktake) ----------
router.get('/par-levels',       authenticate, authorizeStock, rooms.listParLevels);
router.put('/par-levels',       authenticate, authorizeStock, rooms.setParLevels);
router.post('/par-levels/copy', authenticate, authorizeStock, rooms.copyParLevels);
router.get('/room-balance',     authenticate, authorizeStock, rooms.roomBalance);
router.get('/restock-plan',     authenticate, authorizeStock, rooms.restockPlan);
router.post('/stocktake',       authenticate, authorizeStock, rooms.stocktake);

// ---------- Reports (straight SQL over the ledger; no money) ----------
router.get('/reports/reorder',        authenticate, authorizeStock, reports.reorder);
router.get('/reports/consumption',    authenticate, authorizeStock, reports.consumption);
router.get('/reports/recall/:query',  authenticate, authorizeStock, reports.recall);
router.get('/reports/disposal',       authenticate, authorizeStock, reports.disposal);
router.get('/reports/fefo-overrides', authenticate, authorizeStock, reports.fefoOverrides);
router.get('/reports/variances',      authenticate, authorizeStock, reports.variances);
router.get('/reports/inventory',      authenticate, authorizeStock, reports.inventory);

// ---------- Admin maintenance ----------
router.post('/levels/rebuild', authenticate, authorize('admin'), movements.rebuild);

module.exports = router;
