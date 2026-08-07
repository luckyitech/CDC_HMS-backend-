const { Op } = require('sequelize');
const { success } = require('../utils/response');
const { action } = require('../utils/billingHttp');
const { clinicToday, clinicMidnight, nextClinicDate } = require('../utils/clinicTime');
const {
  PAYMENT_METHODS, PAYMENT_TYPES, OUTSTANDING_STATUSES, signFor,
} = require('../constants/billing');
const db = require('../models');

const { Payment, Invoice, InvoiceLine, Patient, User, Queue } = db;

// =====================================================================
// The reports.
//
// Two the desk runs daily (cash-up, outstanding) and three that exist to be
// checked rather than used: unbilled visits, removed items and ad-hoc prices.
// Those three are the audit half of this module — each one makes visible a way
// money could leave the clinic without a record, and each should normally be
// empty or boring. A report nobody ever needs is the point.
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

/**
 * GET /api/billing/reports/unbilled
 *
 * Visits that were discharged without an issued bill.
 *
 * This should be EMPTY. Billing now follows discharge rights, so every checkout
 * raises a bill — a row here means either a service was left unpriced and the
 * draft could not be issued, or something failed. Either way it is money the
 * clinic has not asked for, and the point of the report is that it is no longer
 * invisible: before, an unbilled discharge left no trace anywhere at all.
 */
const unbilled = action('Billing.reports.unbilled', async (req, res) => {
  // Defaults to TODAY, deliberately.
  //
  // Every visit discharged before this module existed is unbilled, and there
  // are hundreds of them. Without a default the report opens on years of
  // history that nobody can act on, and a control that is permanently full is
  // a control nobody reads. The question worth asking is "did anything slip
  // through today", so that is what it answers unless a range is given.
  const from = req.query.from || (req.query.to ? null : clinicToday());
  const where = { status: 'Completed', dischargedAt: { [Op.ne]: null } };

  if (from || req.query.to) {
    where.dischargedAt = {};
    if (from) where.dischargedAt[Op.gte] = clinicMidnight(from);
    if (req.query.to) where.dischargedAt[Op.lt] = clinicMidnight(nextClinicDate(req.query.to));
  }

  const visits = await Queue.findAll({
    where,
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone'] }],
    order: [['dischargedAt', 'DESC']],
    limit: Math.min(Number(req.query.limit) || 200, 1000),
  });

  // A visit counts as billed once it has an invoice that was actually ISSUED.
  // A draft is not a bill: nobody was ever asked to pay it.
  const issued = await Invoice.findAll({
    where: {
      QueueId: { [Op.in]: visits.map((v) => v.id).length ? visits.map((v) => v.id) : [0] },
      status: { [Op.ne]: 'draft' },
    },
    attributes: ['QueueId'],
    raw: true,
  });
  const billedQueueIds = new Set(issued.map((i) => i.QueueId));

  const rows = visits
    .filter((v) => !billedQueueIds.has(v.id))
    .map((v) => ({
      queueId: v.id,
      patient: v.Patient,
      dischargedAt: v.dischargedAt,
      dischargedBy: v.dischargedBy,
      charges: v.finalCharges ?? v.selectedCharges ?? [],
      procedures: v.finalProcedures ?? v.selectedProcedures ?? [],
    }));

  return success(res, { count: rows.length, visits: rows });
});

/**
 * GET /api/billing/reports/removed-items
 *
 * What the doctor ordered versus what was actually billed.
 *
 * The vector every other control here misses: the doctor ticks HbA1c, reception
 * unticks it, the official bill is 3,500 lower, and the patient settles the
 * difference in cash. The bill exists, was issued, and was paid in full —
 * nothing about it looks wrong.
 *
 * The data has always been there: selectedCharges is the doctor's list,
 * finalCharges is reception's, and a reason is already required to remove
 * anything. What was missing is anybody ever comparing the two. One person
 * removing items far more often than everyone else is the pattern worth seeing.
 */
const removedItems = action('Billing.reports.removedItems', async (req, res) => {
  const where = {
    status: 'Completed',
    dischargedAt: { [Op.ne]: null },
    finalCharges: { [Op.ne]: null },
  };

  if (req.query.from || req.query.to) {
    where.dischargedAt = { [Op.ne]: null };
    if (req.query.from) where.dischargedAt[Op.gte] = clinicMidnight(req.query.from);
    if (req.query.to) where.dischargedAt[Op.lt] = clinicMidnight(nextClinicDate(req.query.to));
  }

  const visits = await Queue.findAll({
    where,
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
    order: [['dischargedAt', 'DESC']],
    limit: Math.min(Number(req.query.limit) || 500, 2000),
  });

  const asList = (v) => (Array.isArray(v) ? v : []);
  const rows = [];
  const byStaff = new Map();

  for (const v of visits) {
    const ordered = [...asList(v.selectedCharges), ...asList(v.selectedProcedures)];
    const billed = new Set([...asList(v.finalCharges), ...asList(v.finalProcedures)]);
    const removed = ordered.filter((item) => !billed.has(item));
    if (!removed.length) continue;

    const staff = v.dischargedBy || 'Unknown';
    rows.push({
      queueId: v.id,
      patient: v.Patient,
      dischargedAt: v.dischargedAt,
      dischargedBy: staff,
      removed,
      reason: v.dischargeComment || null,
    });

    const entry = byStaff.get(staff) || { staff, visits: 0, itemsRemoved: 0 };
    entry.visits += 1;
    entry.itemsRemoved += removed.length;
    byStaff.set(staff, entry);
  }

  return success(res, {
    count: rows.length,
    visits: rows,
    byStaff: [...byStaff.values()].sort((a, b) => b.itemsRemoved - a.itemsRemoved),
  });
});

/**
 * GET /api/billing/reports/adhoc-priced
 *
 * Lines whose price was typed at the checkout desk, because the scanned item
 * matched nothing on the price list.
 *
 * Reception may do this so nothing leaves unbilled — but it is the one price in
 * the system the clinic's admin did not set, chosen by the person taking the
 * money. Every one carries a name and appears here. It doubles as the queue of
 * items that ought to be added to the price list properly.
 */
const adhocPriced = action('Billing.reports.adhocPriced', async (req, res) => {
  const where = { pricedAtCheckoutById: { [Op.ne]: null } };

  if (req.query.from || req.query.to) {
    where.createdAt = {};
    if (req.query.from) where.createdAt[Op.gte] = clinicMidnight(req.query.from);
    if (req.query.to) where.createdAt[Op.lt] = clinicMidnight(nextClinicDate(req.query.to));
  }

  const rows = await InvoiceLine.findAll({
    where,
    include: [
      { model: User, as: 'pricedAtCheckoutBy', attributes: ['id', 'firstName', 'lastName'] },
      {
        model: Invoice,
        attributes: ['id', 'invoiceNumber', 'status', 'issuedAt'],
        include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit: Math.min(Number(req.query.limit) || 300, 1000),
  });

  const totalMinor = rows.reduce((total, line) => total + Number(line.grossMinor), 0);
  return success(res, { count: rows.length, totalMinor, lines: rows });
});

module.exports = { cashUp, outstanding, unbilled, removedItems, adhocPriced };
