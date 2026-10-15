const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { error } = require('../utils/response');
const {
  PERMISSIONS, CLINICAL_READ_ROLES, STOCK_TAB_PERMISSIONS, hasAnyPermission, passesGate,
} = require('../constants/permissions');

// Stocks is gated PER TAB (Emu, 13 Oct 2026): each tab of the Stocks page has
// its own capability, and each route below is opened by the tab(s) that use it.
// stockGate(...caps) passes anyone holding at least one of them — withdrawals
// already applied, real admins hold all. (Not authorize(): that refuses when ANY
// listed capability is withdrawn, which would let withdrawing one tab close
// another tab's routes.) tests/permissionVocabulary.test.js lists these
// capabilities under CHECKED_ELSEWHERE for that reason.
const NO_ACCESS = 'You do not have permission to do that — this has not been granted to your account.';
const stockGate = (...caps) => (req, res, next) =>
  (hasAnyPermission(req.user, caps) ? next() : error(res, NO_ACCESS, 403));
// A clinical gate (roles + stock.dispense, as before) OR a Stocks tab: the
// Dispense and Returns tabs drive the same endpoints clinical staff use at
// checkout and point of care.
const clinicalOrTab = (allow, ...caps) => (req, res, next) =>
  ((passesGate(req.user, allow) || hasAnyPermission(req.user, caps)) ? next() : error(res, NO_ACCESS, 403));

const P = PERMISSIONS;
const anyStockTab = stockGate(...STOCK_TAB_PERMISSIONS);   // reference data every tab reads
const catalog = require('../controllers/stockCatalogController');
const movements = require('../controllers/stockMovementController');
const rooms = require('../controllers/stockRoomController');
const reports = require('../controllers/stockReportController');
const receipts = require('../controllers/stockReceiptController');
const invoices = require('../controllers/stockInvoiceController');
const tests = require('../controllers/stockTestController');
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
// Everything here requires authentication. Beyond that, each route names the
// Stocks tab(s) that use it (see stockGate above). Hiding a tab is UX; THESE
// gates are the security boundary, read from the DB on every request, so a
// grant or withdrawal takes effect without re-login.
//   POST /use       — point-of-care usage stays open to all clinical roles.
//                     Gating it would guarantee unrecorded usage.
//   POST /levels/rebuild — admin only (destructive recompute).

const qty = () => body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a whole number of at least 1');

// ---------- Reference data ----------
router.get('/items',        authenticate, anyStockTab, catalog.listItems);
router.post('/items',       authenticate, stockGate(P.STOCK_ITEMS_EDIT), [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createItem);
router.put('/items/:id',    authenticate, stockGate(P.STOCK_ITEMS_EDIT), catalog.updateItem);

router.get('/locations',     authenticate, anyStockTab, catalog.listLocations);
router.post('/locations',    authenticate, stockGate(P.STOCK_ITEMS_EDIT), [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createLocation);
router.put('/locations/:id', authenticate, stockGate(P.STOCK_ITEMS_EDIT), catalog.updateLocation);

router.get('/suppliers',     authenticate, anyStockTab, catalog.listSuppliers);
router.post('/suppliers',    authenticate, stockGate(P.STOCK_ITEMS_EDIT), [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createSupplier);
router.put('/suppliers/:id', authenticate, stockGate(P.STOCK_ITEMS_EDIT), catalog.updateSupplier);

// ---------- Ledger writes (each one DB transaction with row locks) ----------
router.post('/intake', authenticate, stockGate(P.STOCK_RECEIVE), [
  body('stockItemId').isInt().withMessage('stockItemId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  body('receiptNo').optional({ nullable: true }).isString().withMessage('Invoice / receipt number must be text'),
  body('receiptKind').optional().isIn(receipts.KINDS).withMessage('Choose invoice, receipt or delivery note'),
  qty(),
  validate,
], movements.intake);

// ---------- Supplier invoices / receipts + scans (12 Oct 2026) ----------
router.get('/receipts',        authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), receipts.list);
router.get('/receipts/lookup', authenticate, stockGate(P.STOCK_RECEIVE), receipts.lookup);
// Receiving from an invoice (13 Oct 2026, Emu) — the Receive tab's "From an
// invoice" mode. Read → confirm every line → save all in one go. Adding an
// item the catalogue lacks is open to everyone who can receive (same handler
// and validation as Items → Add); it is logged like any catalogue add.
router.get('/receipts/reader',          authenticate, stockGate(P.STOCK_RECEIVE), invoices.status);
router.post('/receipts/read',           authenticate, stockGate(P.STOCK_RECEIVE), handleReceiptUpload, invoices.read);
router.get('/receipts/pending/:token',  authenticate, stockGate(P.STOCK_RECEIVE), invoices.pendingFile);
router.delete('/receipts/pending/:token', authenticate, stockGate(P.STOCK_RECEIVE), invoices.discard);
router.post('/receipts/receive-batch',  authenticate, stockGate(P.STOCK_RECEIVE), [
  body('receiptNo').optional({ nullable: true }).isString().withMessage('Invoice / receipt number must be text'),
  body('receiptKind').optional().isIn(receipts.KINDS).withMessage('Choose invoice, receipt or delivery note'),
  body('supplierId').optional({ nullable: true }).isInt(),
  body('lines').isArray({ min: 1 }).withMessage('There are no lines to save'),
  validate,
], invoices.receiveBatch);
router.post('/receipts/new-item',       authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_ITEMS_EDIT), [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createItem);
// A supplier read from the invoice that is not on the list yet (15 Oct 2026, Emu) — added and remembered.
router.post('/receipts/new-supplier',   authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_ITEMS_EDIT), [body('name').notEmpty().withMessage('Name is required'), validate], catalog.createSupplier);

router.get('/receipts/:id',    authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), receipts.getOne);
router.post('/receipts', authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), [
  body('number').exists({ checkFalsy: true }).withMessage('Enter the invoice / receipt number').bail()
    .isString().trim().notEmpty().withMessage('Enter the invoice / receipt number'),
  body('kind').optional().isIn(receipts.KINDS).withMessage('Choose invoice, receipt or delivery note'),
  body('supplierId').optional({ nullable: true }).isInt(),
  validate,
], receipts.ensure);
router.post('/receipts/:id/documents', authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), handleReceiptUpload, receipts.addDocument);
router.get('/receipts/:id/documents/:docId', authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), receipts.getDocument);
router.delete('/receipts/:id/documents/:docId', authenticate, stockGate(P.STOCK_RECEIVE, P.STOCK_MOVEMENTS), receipts.removeDocument);

// Correcting a received line (13 Oct 2026) — Movements → Deliveries, "Can edit deliveries".
router.put('/batches/:id/received', authenticate, stockGate(P.STOCK_DELIVERIES_EDIT), [
  body('reason').trim().isLength({ min: 3 }).withMessage('Give a reason for the correction'),
  validate,
], receipts.editLine);
router.get('/batches/:id/edits', authenticate, stockGate(P.STOCK_MOVEMENTS, P.STOCK_RECEIVE), receipts.lineEdits);

router.post('/dispense', authenticate, stockGate(P.STOCK_DISPENSE_TAB), [
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
router.get('/fefo-suggestion', authenticate, clinicalOrTab(['doctor', 'nurse', 'admin', P.STOCK_DISPENSE], P.STOCK_DISPENSE_TAB), movements.fefoSuggestion);

// A patient's dispensing history — patient-care context, every internal role
// (exposes only this patient's own rows), not a stock capability. It renders inside
// the patient file's Visit History, so it follows the patient-record read list
// rather than the stock capability.
router.get('/patient-dispenses', authenticate, authorize(...CLINICAL_READ_ROLES), movements.patientDispenses);

// Checkout dispense — reception dispenses the supplies scanned on a patient's
// discharge charge sheet, patient-linked, in one transaction. Clinical/
// reception roles, NOT a stock capability (same rationale as /use).
router.post('/checkout-dispense', authenticate, clinicalOrTab(['doctor', 'admin', P.STOCK_DISPENSE], P.STOCK_DISPENSE_TAB), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('lines').isArray({ min: 1 }).withMessage('At least one supply line is required'),
  validate,
], movements.checkoutDispense);

// Returns — a patient brings stock back. Patient-linked (recall traceability),
// reason required. Clinical/reception roles, NOT a stock capability (same rationale
// as /use and /checkout-dispense).
router.post('/return', authenticate, clinicalOrTab(['doctor', 'admin', P.STOCK_DISPENSE], P.STOCK_RETURNS), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('reason').notEmpty().withMessage('A reason is required'),
  qty(),
  validate,
], movements.returnStock);

// Whether a scanned batch was ever returned (and why) — drives the dispense
// warning. Clinical/reception roles.
router.get('/batches/:id/return-info', authenticate, clinicalOrTab(['doctor', 'admin', P.STOCK_DISPENSE], P.STOCK_DISPENSE_TAB, P.STOCK_RETURNS), movements.batchReturnInfo);

// Back to the supplier (13 Oct 2026) — Returns tab → "To a supplier".
router.post('/supplier-return', authenticate, stockGate(P.STOCK_RETURNS), [
  qty(),
  body('locationId').isInt().withMessage('Choose the location the stock leaves from'),
  body('reason').trim().notEmpty().withMessage('A reason is required'),
  validate,
], movements.supplierReturn);

router.post('/transfer', authenticate, stockGate(P.STOCK_TRANSFER, P.STOCK_ROOMS_EDIT), [
  body('fromLocationId').isInt().withMessage('fromLocationId is required'),
  body('toLocationId').isInt().withMessage('toLocationId is required'),
  qty(),
  validate,
], movements.transfer);

router.post('/adjustment', authenticate, stockGate(P.STOCK_STOCKTAKE), [
  body('stockBatchId').isInt().withMessage('stockBatchId is required'),
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for adjustments'),
  qty(),
  validate,
], movements.adjustment);

router.post('/writeoff', authenticate, stockGate(P.STOCK_WRITEOFF), [
  body('locationId').isInt().withMessage('locationId is required'),
  body('reason').notEmpty().withMessage('A reason is required for write-offs'),
  qty(),
  validate,
], movements.writeoff);

// No reversal route (Emu, 13 Oct 2026): nobody reverses a movement — a mistake
// is corrected through the tabs (dispense, return, transfer; stocktake and
// write-off). utils/stockLedger.reverseMovement stays for the ledger tests only.

// ---------- Tests that use stock (13 Oct 2026) ----------
// Set up in Items → Tests ("add and edit items"); not-taken attempts settle from
// Analytics → Today ("write off expired stock" holders run that list).
router.get('/tests/not-taken',             authenticate, stockGate(P.STOCK_ANALYTICS), tests.notTaken);
router.post('/tests/not-taken/:id/retry',  authenticate, stockGate(P.STOCK_ANALYTICS), tests.retry);
router.post('/tests/not-taken/:id/resolve', authenticate, stockGate(P.STOCK_WRITEOFF), tests.resolve);

// ---------- Reads ----------
router.get('/movements', authenticate, stockGate(P.STOCK_MOVEMENTS, P.STOCK_RECEIVE), movements.listMovements);
router.get('/levels',    authenticate, anyStockTab, movements.listLevels);
router.get('/batches',   authenticate, anyStockTab, movements.listBatches);
router.get('/dashboard', authenticate, stockGate(P.STOCK_ANALYTICS), movements.dashboard);

// Record-Use options — clinical roles, NOT a stock capability (matches POST /use):
// only what point-of-care recording needs, nothing more.
router.get('/use-options', authenticate, authorize('doctor', 'nurse', 'admin', PERMISSIONS.STOCK_DISPENSE), movements.useOptions);

// ---------- Room balancing (par levels, RAG grid, restock, stocktake) ----------
router.get('/par-levels',       authenticate, stockGate(P.STOCK_ROOMS), rooms.listParLevels);
router.put('/par-levels',       authenticate, stockGate(P.STOCK_ROOMS_EDIT), rooms.setParLevels);
router.post('/par-levels/copy', authenticate, stockGate(P.STOCK_ROOMS_EDIT), rooms.copyParLevels);
router.get('/room-balance',     authenticate, stockGate(P.STOCK_ROOMS), rooms.roomBalance);
router.get('/restock-plan',     authenticate, stockGate(P.STOCK_ROOMS), rooms.restockPlan);
router.post('/stocktake',       authenticate, stockGate(P.STOCK_STOCKTAKE), rooms.stocktake);

// ---------- Reports (straight SQL over the ledger; no money) ----------
router.get('/reports/reorder',        authenticate, stockGate(P.STOCK_ANALYTICS), reports.reorder);
router.get('/reports/consumption',    authenticate, stockGate(P.STOCK_ANALYTICS), reports.consumption);
router.get('/reports/recall/:query',  authenticate, stockGate(P.STOCK_ANALYTICS), reports.recall);
router.get('/reports/walk-ins',       authenticate, stockGate(P.STOCK_ANALYTICS), reports.walkIns);
router.get('/reports/disposal',       authenticate, stockGate(P.STOCK_ANALYTICS), reports.disposal);
router.get('/reports/fefo-overrides', authenticate, stockGate(P.STOCK_ANALYTICS), reports.fefoOverrides);
router.get('/reports/variances',      authenticate, stockGate(P.STOCK_ANALYTICS), reports.variances);
router.get('/reports/inventory',      authenticate, stockGate(P.STOCK_ANALYTICS), reports.inventory);
router.get('/reports/expiry',         authenticate, stockGate(P.STOCK_ANALYTICS), reports.expiry);
router.get('/reports/audit',          authenticate, stockGate(P.STOCK_ANALYTICS), reports.audit);

// ---------- Admin maintenance ----------
router.post('/levels/rebuild', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), movements.rebuild);

module.exports = router;
