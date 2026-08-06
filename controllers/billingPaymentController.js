const { Op } = require('sequelize');
const { success } = require('../utils/response');
const { action, readAmount } = require('../utils/billingHttp');
const { recordPayment, reversePayment, findInvoice, BillingError } = require('../utils/billingLedger');
const { clinicMidnight, nextClinicDate } = require('../utils/clinicTime');
const db = require('../models');

const { Payment, Invoice, Patient, User } = db;

// =====================================================================
// Payments — recording money that has already moved.
//
// The card cleared on the bank's terminal; the M-Pesa cleared on Safaricom's
// rails. What happens here is bookkeeping, and the reference captured with each
// one is what lets the admin tie the day's takings back to a statement.
//
// Nothing is ever edited. A mistake is corrected with a reversal, which is a
// row of its own that both parties can see.
// =====================================================================

const PAYMENT_INCLUDES = [
  { model: User, as: 'receivedByUser', attributes: ['id', 'firstName', 'lastName'] },
  {
    model: Invoice,
    attributes: ['id', 'invoiceNumber', 'totalMinor', 'balanceMinor', 'status'],
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
  },
];

/**
 * POST /api/billing/payments
 *
 * Body: { invoiceId, method, amount, reference?, cardLast4?, insuranceScheme?,
 *         insuranceMemberNo?, type? }
 *
 * `amount` is the decimal a person typed; it becomes minor units here and is
 * never a decimal again. Which reference fields are required is decided by the
 * method's entry in constants/billing.js, not by this controller.
 */
const record = action('Billing.payments.record', async (req, res) => {
  const {
    invoiceId, method, type = 'payment', reference,
    cardLast4, insuranceScheme, insuranceMemberNo, reason,
  } = req.body;

  if (!invoiceId) throw new BillingError('An invoice is required');

  const payment = await recordPayment({
    invoiceId,
    type,
    method,
    amountMinor: readAmount(req.body, 'amount', { label: 'Amount' }),
    reference,
    cardLast4,
    insuranceScheme,
    insuranceMemberNo,
    reason,
    receivedById: req.user.id,
  });

  // The invoice comes back with it: the desk needs the new balance immediately,
  // and a second round trip to fetch it is a window where the screen shows a
  // balance that is already wrong.
  return success(res, {
    payment: await Payment.findByPk(payment.id, { include: PAYMENT_INCLUDES }),
    invoice: await findInvoice(payment.invoiceId),
  }, 201);
});

/**
 * POST /api/billing/payments/:id/reverse
 *
 * The only way to correct a payment. Writes a mirror row for the full amount —
 * a partial correction is a refund, which has its own type.
 */
const reverse = action('Billing.payments.reverse', async (req, res) => {
  const reversal = await reversePayment(req.params.id, {
    userId: req.user.id,
    reason: req.body.reason,
  });

  return success(res, {
    reversal: await Payment.findByPk(reversal.id, { include: PAYMENT_INCLUDES }),
    invoice: await findInvoice(reversal.invoiceId),
  }, 201);
});

/** GET /api/billing/payments — filterable by invoice, method, type and date. */
const list = action('Billing.payments.list', async (req, res) => {
  const where = {};

  if (req.query.invoiceId) where.invoiceId = Number(req.query.invoiceId);
  if (req.query.method) where.method = req.query.method.split(',');
  if (req.query.type) where.type = req.query.type.split(',');

  if (req.query.from || req.query.to) {
    where.receivedAt = {};
    if (req.query.from) where.receivedAt[Op.gte] = clinicMidnight(req.query.from);
    if (req.query.to) where.receivedAt[Op.lt] = clinicMidnight(nextClinicDate(req.query.to));
  }

  const rows = await Payment.findAll({
    where,
    include: PAYMENT_INCLUDES,
    order: [['receivedAt', 'DESC']],
    limit: Math.min(Number(req.query.limit) || 200, 1000),
  });

  return success(res, rows);
});

module.exports = { record, reverse, list };
