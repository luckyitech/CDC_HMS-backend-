const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');

const services = require('../controllers/billingCatalogController');
const invoices = require('../controllers/billingInvoiceController');
const payments = require('../controllers/billingPaymentController');
const reports = require('../controllers/billingReportController');
const config = require('../controllers/billingSettingsController');

// ====================================
// UNDERSTANDING AUTHORIZATION
// ====================================
// Everything here requires authentication. Beyond that:
//
//   authorizeBilling  — admins (implicitly), plus anyone granted
//                       'billing.manage'. Read from the DB on every request, so
//                       a grant or revoke takes effect without re-login.
//
//   GET /services     — the ONE exception: readable by every clinical role,
//                       because the doctor's charge list is built from it.
//                       Prices are stripped from the response for anyone
//                       without 'billing.viewPrices' — see serviceItemFor in
//                       utils/billingHttp.js. Hiding a column in the UI is not
//                       a boundary; the browser can call this endpoint itself.
//
//   PUT /config       — admin only. The VAT rate and the KRA PIN appear on every
//                       tax invoice the clinic issues.
//
//   POST /invoices/rebuild-totals — admin only (recomputes every invoice).
//
// Money is never accepted as a number of cents from a client. Amounts arrive as
// decimal strings and are converted once, at the controller, by readAmount.
const authorizeBilling = requirePermission(PERMISSIONS.BILLING_MANAGE);

// ---------- Price list ----------
// Read: any clinical role. Write: billing.manage.
router.get('/services', authenticate, authorize('doctor', 'staff', 'lab', 'admin'), services.list);

router.post('/services', authenticate, authorizeBilling, [
  body('name').notEmpty().withMessage('Name is required'),
  validate,
], services.create);

router.put('/services/:id', authenticate, authorizeBilling, services.update);
router.delete('/services/:id', authenticate, authorizeBilling, services.retire);

// ---------- Invoices ----------
router.get('/invoices', authenticate, authorizeBilling, invoices.list);
router.get('/invoices/for-queue/:queueId', authenticate, authorizeBilling, invoices.getForQueue);
router.get('/invoices/:id', authenticate, authorizeBilling, invoices.getOne);

router.post('/invoices', authenticate, authorizeBilling, [
  body('PatientId').isInt().withMessage('A patient is required'),
  validate,
], invoices.create);

// Opens the checkout for a visit. Idempotent — a second call returns the bill
// already open rather than trying to raise another.
router.post('/invoices/from-queue/:queueId', authenticate, authorizeBilling, invoices.createFromQueue);

router.put('/invoices/:id', authenticate, authorizeBilling, invoices.update);

// Re-price a draft from what the checkout screen currently shows. The screen
// sends its SELECTION (ticked labels, scanned batches), never priced lines —
// the label-to-price mapping and all VAT arithmetic stay server-side.
router.put('/invoices/:id/selection', authenticate, authorizeBilling, invoices.updateSelection);
router.post('/invoices/:id/issue', authenticate, authorizeBilling, invoices.issue);

router.post('/invoices/:id/void', authenticate, authorizeBilling, [
  body('reason').notEmpty().withMessage('A reason is required to void an invoice'),
  validate,
], invoices.cancel);

router.delete('/invoices/:id', authenticate, authorizeBilling, invoices.discard);

// Admin only — recompute every invoice from its lines and payments.
router.post('/invoices/rebuild-totals', authenticate, authorize('admin'), invoices.rebuildTotals);

// ---------- Payments (append-only) ----------
router.get('/payments', authenticate, authorizeBilling, payments.list);

router.post('/payments', authenticate, authorizeBilling, [
  body('invoiceId').isInt().withMessage('An invoice is required'),
  body('method').notEmpty().withMessage('A payment method is required'),
  body('amount').notEmpty().withMessage('An amount is required'),
  validate,
], payments.record);

// The only correction path — payment rows are immutable.
router.post('/payments/:id/reverse', authenticate, authorizeBilling, [
  body('reason').notEmpty().withMessage('A reason is required to reverse a payment'),
  validate,
], payments.reverse);

// ---------- Reports ----------
router.get('/reports/cash-up', authenticate, authorizeBilling, reports.cashUp);
router.get('/reports/outstanding', authenticate, authorizeBilling, reports.outstanding);

// ---------- Clinic configuration ----------
router.get('/config', authenticate, authorizeBilling, config.get);
router.put('/config', authenticate, authorize('admin'), config.update);

module.exports = router;
