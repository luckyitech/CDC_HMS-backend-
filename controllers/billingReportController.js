const { Op } = require('sequelize');
const { success } = require('../utils/response');
const { action } = require('../utils/billingHttp');
const { clinicToday, clinicMidnight, nextClinicDate } = require('../utils/clinicTime');
const {
  PAYMENT_METHODS, PAYMENT_TYPES, OUTSTANDING_STATUSES, signFor,
} = require('../constants/billing');
const db = require('../models');

const { Payment, Invoice, Patient, User } = db;

// =====================================================================
// The two reports the desk actually runs.
//
//   Cash-up    — what came in today, split by method and by who took it. The
//                sheet that gets tied out against the drawer, the M-Pesa
//                statement and the bank's card settlement file.
//   Outstanding— who owes money, oldest first.
//
// Both read the ledger and compute nothing that is stored anywhere, so they can
// never be the thing that makes the books wrong.
// =====================================================================

/**
 * Group rows into { key, label, count, totalMinor }, applying each payment's
 * sign so a reversal SUBTRACTS from the day rather than inflating it.
 *
 * Summing amountMinor directly would report a till that took KES 10,000 and
 * reversed KES 2,000 as having taken KES 12,000 — the single most
 * consequential mistake a cash-up report can make.
 */
const groupPayments = (payments, keyOf, labelOf) => {
  const groups = new Map();

  payments.forEach((payment) => {
    const key = keyOf(payment);
    if (key === null || key === undefined) return;

    if (!groups.has(key)) {
      groups.set(key, { key, label: labelOf(payment), count: 0, totalMinor: 0 });
    }
    const group = groups.get(key);
    group.count += 1;
    group.totalMinor += signFor(payment.type) * Number(payment.amountMinor);
  });

  return [...groups.values()].sort((a, b) => b.totalMinor - a.totalMinor);
};

const fullName = (user) => (user ? `${user.firstName} ${user.lastName}`.trim() : 'Unknown');

/**
 * GET /api/billing/reports/cash-up?date=YYYY-MM-DD
 *
 * Defaults to today at the CLINIC, not in UTC — at +03 a UTC "today" starts at
 * 03:00, so the first three hours of trading would land on the previous day's
 * sheet and neither day would reconcile.
 */
const cashUp = action('Billing.reports.cashUp', async (req, res) => {
  const date = req.query.date || clinicToday();

  const payments = await Payment.findAll({
    where: {
      receivedAt: {
        [Op.gte]: clinicMidnight(date),
        [Op.lt]: clinicMidnight(nextClinicDate(date)),
      },
    },
    include: [
      { model: User, as: 'receivedByUser', attributes: ['id', 'firstName', 'lastName'] },
      { model: Invoice, attributes: ['id', 'invoiceNumber'] },
    ],
    order: [['receivedAt', 'ASC']],
  });

  const byMethod = groupPayments(
    payments,
    (p) => p.method,
    (p) => PAYMENT_METHODS[p.method]?.label || p.method
  );
  const byUser = groupPayments(
    payments,
    (p) => p.receivedById,
    (p) => fullName(p.receivedByUser)
  );
  const byType = groupPayments(
    payments,
    (p) => p.type,
    (p) => PAYMENT_TYPES[p.type]?.label || p.type
  );

  const totalMinor = payments.reduce(
    (total, p) => total + signFor(p.type) * Number(p.amountMinor),
    0
  );

  return success(res, {
    date,
    totalMinor,
    count: payments.length,
    byMethod,
    byUser,
    byType,
    payments,
  });
});

/**
 * GET /api/billing/reports/outstanding
 *
 * The debtors list. Oldest first, because the oldest is the one least likely to
 * ever be collected.
 */
const outstanding = action('Billing.reports.outstanding', async (req, res) => {
  const where = {
    status: OUTSTANDING_STATUSES,
    balanceMinor: { [Op.gt]: 0 },
  };
  if (req.query.patientId) where.PatientId = Number(req.query.patientId);

  const rows = await Invoice.findAll({
    where,
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone'] }],
    order: [['issuedAt', 'ASC']],
    limit: Math.min(Number(req.query.limit) || 500, 2000),
  });

  const totalMinor = rows.reduce((total, invoice) => total + Number(invoice.balanceMinor), 0);

  return success(res, { totalMinor, count: rows.length, invoices: rows });
});

module.exports = { cashUp, outstanding };
