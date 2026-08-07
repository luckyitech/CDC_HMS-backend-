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
// Everything here requires authentication. Beyond that the split is by WHAT THE
// ACTION IS, not by who is doing it:
//
//   authorizeCheckout — anyone who may discharge a patient, which is exactly
//                       authorize('staff', 'doctor') in routes/queue.js, plus
//                       admins implicitly. Raising a bill, pricing it and
//                       banking a payment are part of doing the job at the desk.
//
//                       This deliberately does NOT require 'billing.manage'.
//                       When it did, a receptionist without the permission
//                       discharged patients and NO BILL WAS CREATED AT ALL — no
//                       invoice, no draft, nothing on any report. Take the
//                       patient's cash, discharge them, and the system held no
//                       record that anything was ever owed. Requiring a
//                       permission to bill did not prevent that fraud; it
//                       guaranteed it left no trace.
//
//   authorizeBilling  — 'billing.manage'. Reserved for changing or UNDOING the
//                       record: setting prices, voiding an invoice, reversing a
//                       payment, and the reports that review all of it. Doing
//                       the job is routine; overriding the record is where theft
//                       lives, so that is what the permission guards.
//
//   GET /services     — readable by every clinical role, because the doctor's
//                       charge list is built from it. Prices are stripped for
//                       anyone without 'billing.viewPrices' — see serviceItemFor
//                       in utils/billingHttp.js. Hiding a column in the UI is not
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

// Matches routes/queue.js's discharge guard exactly, so the right to bill a
// visit can never drift apart from the right to end one.
const authorizeCheckout = authorize('staff', 'doctor', 'admin');

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
router.get('/invoices', authenticate, authorizeCheckout, invoices.list);
router.get('/invoices/for-queue/:queueId', authenticate, authorizeCheckout, invoices.getForQueue);
router.get('/invoices/:id', authenticate, authorizeCheckout, invoices.getOne);

router.post('/invoices', authenticate, authorizeCheckout, [
  body('PatientId').isInt().withMessage('A patient is required'),
  validate,
], invoices.create);

// Opens the checkout for a visit. Idempotent — a second call returns the bill
// already open rather than trying to raise another.
router.post('/invoices/from-queue/:queueId', authenticate, authorizeCheckout, invoices.createFromQueue);

router.put('/invoices/:id', authenticate, authorizeCheckout, invoices.update);

// Re-price a draft from what the checkout screen currently shows. The screen
// sends its SELECTION (ticked labels, scanned batches), never priced lines —
// the label-to-price mapping and all VAT arithmetic stay server-side.
router.put('/invoices/:id/selection', authenticate, authorizeCheckout, invoices.updateSelection);
router.post('/invoices/:id/issue', authenticate, authorizeCheckout, invoices.issue);

router.post('/invoices/:id/void', authenticate, authorizeBilling, [
  body('reason').notEmpty().withMessage('A reason is required to void an invoice'),
  validate,
], invoices.cancel);

router.delete('/invoices/:id', authenticate, authorizeCheckout, invoices.discard);

// Admin only — recompute every invoice from its lines and payments.
router.post('/invoices/rebuild-totals', authenticate, authorize('admin'), invoices.rebuildTotals);

// ---------- Payments (append-only) ----------
router.get('/payments', authenticate, authorizeCheckout, payments.list);

router.post('/payments', authenticate, authorizeCheckout, [
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
// All 'billing.manage': these review the record rather than create it, and the
// last three exist specifically to be checked BY someone other than the person
// at the desk.
router.get('/reports/cash-up', authenticate, authorizeBilling, reports.cashUp);
router.get('/reports/outstanding', authenticate, authorizeBilling, reports.outstanding);

// The audit three. Each makes visible a way money could leave without a record:
//   unbilled       — a visit discharged with no bill issued (should be empty)
//   removed-items  — what the doctor ordered vs what was actually billed
//   adhoc-priced   — prices typed at the desk rather than set by an admin
router.get('/reports/unbilled', authenticate, authorizeBilling, reports.unbilled);
router.get('/reports/removed-items', authenticate, authorizeBilling, reports.removedItems);
router.get('/reports/adhoc-priced', authenticate, authorizeBilling, reports.adhocPriced);

// ---------- Clinic configuration ----------
// READ is open to the checkout: the payment method picker, the reference-field
// rules and the currency all come from here, so a receptionist who could not
// read it would be shown a payment form with no methods on it. It carries no
// patient data and nothing secret — the VAT rate and the clinic's own KRA PIN
// are printed on every invoice handed to a patient.
router.get('/config', authenticate, authorizeCheckout, config.get);
router.put('/config', authenticate, authorize('admin'), config.update);

module.exports = router;
