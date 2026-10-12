const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { PERMISSIONS, CLINICAL_READ_ROLES } = require('../constants/permissions');

// The stock module's two capabilities. Was a bespoke authorizeStock middleware
// reading a dedicated boolean column, then a single all-or-nothing
// 'stock.manage'; now split so visibility and the ability to move the ledger can
// be granted separately. A holder of stock.write always holds stock.access too
// (constants/permissions.js enforces the implication), so stockRead never has to
// test for both.
const stockRead  = requirePermission(PERMISSIONS.STOCK_ACCESS);
const stockWrite = requirePermission(PERMISSIONS.STOCK_WRITE);
const catalog = require('../controllers/stockCatalogController');
const movements = require('../controllers/stockMovementController');
const rooms = require('../controllers/stockRoomController');
const reports = require('../controllers/stockReportController');
const receipts = require('../controllers/stockReceiptController');
const uploadStockReceipt = require('../middleware/uploadStockReceipt');

const handleReceiptUpload = (req, res, next) =>
  uploadStockReceipt.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 15MB.' : err.message || 'Upload failed';
    return res.status(400).json({ success: false, message });
  });

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Everything here requires authentication. Beyond that:
//   stockRead       — admins (implicitly), plus anyone granted 'stock.access':
//                     may look at the module but not change it.
//   stockWrite      — anyone granted 'stock.write': may move the ledger.
//                     Both are read from the DB on every request, so a grant or
//                     revoke takes effect without re-login. Hiding the sidebar
//                     link is UX; THESE are the security boundary.
//   POST /use       — the one exception: point-of-care usage recording is
//                     open to all clinical roles. Gating it would guarantee
//                     unrecorded usage and rotten room counts.
//   POST /levels/rebuild — admin only (destructive recompute).

const qty = () => body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a whole number of at least 1');

// ---------- Reference data ----------
router.get('/items',        authenticate, stockRead, catalog.listItems);
router.post('/items',       authenticate, stockWrite, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createItem);
router.put('/items/:id',    authenticate, stockWrite, catalog.updateItem);

router.get('/locations',     authenticate, stockRead, catalog.listLocations);
router.post('/locations',    authenticate, stockWrite, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createLocation);
router.put('/locations/:id', authenticate, stockWrite, catalog.updateLocation);

router.get('/suppliers',     authenticate, stockRead, catalog.listSuppliers);
router.post('/suppliers',    authenticate, stockWrite, [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createSupplier);
router.put('/suppliers/:id', authenticate, stockWrite, catalog.updateSupplier);

// ---------- Ledger writes (each one DB transaction with row locks) ----------
router.post('/intake', authenticate, stockWrite, [
  body('stockItemId').isInt().withMessage('stockItemId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  body('receiptNo').exists({ checkFalsy: true }).withMessage('Enter the invoice / receipt number for this delivery').bail()
    .isString().trim().notEmpty().withMessage('Enter the invoice / receipt number for this delivery'),
  body('receiptKind').optional().isIn(receipts.KINDS).withMessage('Choose invoice, receipt or delivery note'),
  qty(),
  validate,
], movements.intake);

// ---------- Supplier invoices / receipts + scans (12 Oct 2026) ----------
router.get('/receipts',        authenticate, stockRead, receipts.list);
router.get('/receipts/lookup', authenticate, stockRead, receipts.lookup);
router.get('/receipts/:id',    authenticate, stockRead, receipts.getOne);
router.post('/receipts', authenticate, stockWrite, [
  body('number').exists({ checkFalsy: true }).withMessage('Enter the invoice / receipt number').bail()
    .isString().trim().notEmpty().withMessage('Enter the invoice / receipt number'),
  body('kind').optional().isIn(receipts.KINDS).withMessage('Choose invoice, receipt or delivery note'),
  body('supplierId').optional({ nullable: true }).isInt(),
  validate,
], receipts.ensure);
router.post('/receipts/:id/documents', authenticate, stockWrite, handleReceiptUpload, receipts.addDocument);
router.get('/receipts/:id/documents/:docId', authenticate, stockRead, receipts.getDocument);
router.delete('/receipts/:id/documents/:docId', authenticate, stockWrite, receipts.removeDocument);

router.post('/dispense', authenticate, stockWrite, [
  body('locationId').isInt().withMessage('locationId is required'),
  qty(),
  validate,
], movements.dispense);

// Point-of-care use — clinical roles, NOT a stock capability (see header note).
router.post('/use', authenticate, authorize('doctor', 'nurse', 'admin', PERMISSIONS.STOCK_DISPENSE), [
  body('locationId').isInt().withMessage('locationId is required'),
  qty(),
  validate,
], movements.use);

// FEFO suggestion for the checkout nudge — clinical/reception roles.
router.get('/fefo-suggestion', authenticate, authorize('doctor', 'nurse', 'admin', PERMISSIONS.STOCK_DISPENSE), movements.fefoSuggestion);

// A patient's dispensing history — patient-care context, every internal role
// (exposes only this patient's own rows), not a stock capability. It renders inside
// the patient file's Visit History, so it follows the patient-record read list
// rather than the stock capability.
router.get('/patient-dispenses', authenticate, authorize(...CLINICAL_READ_ROLES), movements.patientDispenses);

// Checkout dispense — reception dispenses the supplies scanned on a patient's
// discharge charge sheet, patient-linked, in one transaction. Clinical/
// reception roles, NOT a stock capability (same rationale as /use).
router.post('/checkout-dispense', authenticate, authorize('doctor', 'admin', PERMISSIONS.STOCK_DISPENSE), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('lines').isArray({ min: 1 }).withMessage('At least one supply line is required'),
  validate,
], movements.checkoutDispense);

// Returns — a patient brings stock back. Patient-linked (recall traceability),
// reason required. Clinical/reception roles, NOT a stock capability (same rationale
// as /use and /checkout-dispense).
router.post('/return', authenticate, authorize('doctor', 'admin', PERMISSIONS.STOCK_DISPENSE), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('reason').notEmpty().withMessage('A reason is required'),
  qty(),
  validate,
], movements.returnStock);

// Whether a scanned batch was ever returned (and why) — drives the dispense
// warning. Clinical/reception roles.
router.get('/batches/:id/return-info', authenticate, authorize('doctor', 'admin', PERMISSIONS.STOCK_DISPENSE), movements.batchReturnInfo);

router.post('/transfer', authenticate, stockWrite, [
  body('fromLocationId').isInt().withMessage('fromLocationId is required'),
  body('toLocationId').isInt().withMessage('toLocationId is required'),
  qty(),
  validate,
], movements.transfer);

router.post('/adjustment', authenticate, stockWrite, [
  body('stockBatchId').isInt().withMessage('stockBatchId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for adjustments'),
  qty(),
  validate,
], movements.adjustment);

router.post('/writeoff', authenticate, stockWrite, [
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for write-offs'),
  qty(),
  validate,
], movements.writeoff);

router.post('/movements/:id/reverse', authenticate, stockWrite, [
  body('reason').notEmpty().withMessage('A reason is required to reverse a movement'),
  validate,
], movements.reverse);

// ---------- Reads ----------
router.get('/movements', authenticate, stockRead, movements.listMovements);
router.get('/levels',    authenticate, stockRead, movements.listLevels);
router.get('/batches',   authenticate, stockRead, movements.listBatches);
router.get('/dashboard', authenticate, stockRead, movements.dashboard);

// Record-Use options — clinical roles, NOT a stock capability (matches POST /use):
// only what point-of-care recording needs, nothing more.
router.get('/use-options', authenticate, authorize('doctor', 'nurse', 'admin', PERMISSIONS.STOCK_DISPENSE), movements.useOptions);

// ---------- Room balancing (par levels, RAG grid, restock, stocktake) ----------
router.get('/par-levels',       authenticate, stockRead, rooms.listParLevels);
router.put('/par-levels',       authenticate, stockWrite, rooms.setParLevels);
router.post('/par-levels/copy', authenticate, stockWrite, rooms.copyParLevels);
router.get('/room-balance',     authenticate, stockRead, rooms.roomBalance);
router.get('/restock-plan',     authenticate, stockRead, rooms.restockPlan);
router.post('/stocktake',       authenticate, stockWrite, rooms.stocktake);

// ---------- Reports (straight SQL over the ledger; no money) ----------
router.get('/reports/reorder',        authenticate, stockRead, reports.reorder);
router.get('/reports/consumption',    authenticate, stockRead, reports.consumption);
router.get('/reports/recall/:query',  authenticate, stockRead, reports.recall);
router.get('/reports/disposal',       authenticate, stockRead, reports.disposal);
router.get('/reports/fefo-overrides', authenticate, stockRead, reports.fefoOverrides);
router.get('/reports/variances',      authenticate, stockRead, reports.variances);
router.get('/reports/inventory',      authenticate, stockRead, reports.inventory);

// ---------- Admin maintenance ----------
router.post('/levels/rebuild', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), movements.rebuild);

module.exports = router;
