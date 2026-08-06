const { Op } = require('sequelize');
const { success } = require('../utils/response');
const { action } = require('../utils/billingHttp');
const {
  createDraft, updateDraft, issueInvoice, voidInvoice, discardDraft,
  rebuildInvoiceTotals, findInvoice, INVOICE_INCLUDES, BillingError,
} = require('../utils/billingLedger');
const { OUTSTANDING_STATUSES } = require('../constants/billing');
const { clinicMidnight, nextClinicDate } = require('../utils/clinicTime');
const db = require('../models');

const { Invoice, ServiceItem, StockBatch, Queue, Patient, User } = db;

// =====================================================================
// Invoices — draft, issue, void.
//
// Every write goes through utils/billingLedger. Nothing here computes a total,
// assigns a number or sets a status: those are ledger invariants, and a
// controller that reached around them would be the exact bug the ledger exists
// to make impossible.
// =====================================================================

const PATIENT_ATTRS = ['id', 'uhid', 'firstName', 'lastName', 'phone'];

const LIST_INCLUDES = [
  { model: Patient, attributes: PATIENT_ATTRS },
  { model: User, as: 'issuedByUser', attributes: ['id', 'firstName', 'lastName'] },
];

const DETAIL_INCLUDES = () => [...INVOICE_INCLUDES(), ...LIST_INCLUDES];

// ---------------------------------------------------------------------
// Building a draft from a visit
//
// The doctor ticks labels; reception bills money. This is where the two meet:
// each label is looked up in the price list BY NAME, because that is what the
// consultation screen stores and what Queue.selectedCharges has always held.
//
// A label with no matching price list row becomes an UNPRICED line rather than
// being dropped. Dropping it would quietly bill the patient less than they were
// given, and nobody would ever find out; an unpriced line is visible at the
// desk and blocks issuing until it is resolved.
// ---------------------------------------------------------------------
const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * Map a checkout selection — the labels the doctor ticked and the batches
 * reception scanned — onto priced invoice lines.
 *
 * This lives on the SERVER and only on the server. The checkout screen sends
 * what it has on screen and gets back priced lines; it never resolves a label
 * to a service item itself. Two implementations of this mapping would be two
 * things to keep in step, and the day they diverge the patient is shown one
 * total and billed another.
 */
const buildLinesFromSelection = async ({ charges = [], procedures = [], supplies = [] }) => {
  const labels = [...asList(charges), ...asList(procedures)]
    .map((label) => String(label).trim())
    .filter(Boolean);

  const matches = labels.length
    ? await ServiceItem.findAll({ where: { name: { [Op.in]: labels }, status: 'active' } })
    : [];
  const byName = new Map(matches.map((item) => [item.name, item]));

  const lines = labels.map((label) => {
    const item = byName.get(label);
    // No price list row: carry the label so it is visibly unbilled.
    return item ? { serviceItemId: item.id } : { description: label, unitPriceMinor: null };
  });

  // Supplies are scanned batches. The batch names a StockItem, and a service
  // item linked to that StockItem is what prices it.
  const supplyLines = asList(supplies);
  if (supplyLines.length) {
    const batchIds = supplyLines.map((s) => s.stockBatchId).filter(Boolean);
    const batches = batchIds.length
      ? await StockBatch.findAll({ where: { id: { [Op.in]: batchIds } }, attributes: ['id', 'stockItemId'] })
      : [];
    const stockItemByBatch = new Map(batches.map((b) => [b.id, b.stockItemId]));

    const stockItemIds = [...new Set([...stockItemByBatch.values()])];
    const priced = stockItemIds.length
      ? await ServiceItem.findAll({ where: { stockItemId: { [Op.in]: stockItemIds }, status: 'active' } })
      : [];
    const byStockItem = new Map(priced.map((item) => [item.stockItemId, item]));

    supplyLines.forEach((supply) => {
      const item = byStockItem.get(stockItemByBatch.get(supply.stockBatchId));
      const quantity = Number(supply.quantity) || 1;
      lines.push(item
        ? { serviceItemId: item.id, quantity, stockBatchId: supply.stockBatchId }
        : { description: supply.name, quantity, unitPriceMinor: null, stockBatchId: supply.stockBatchId });
    });
  }

  return lines;
};

/**
 * The same mapping, for a visit whose selection is already saved.
 *
 * finalCharges wins when reception has been through the modal once; otherwise
 * the doctor's original selection is the starting point.
 */
const buildLinesFromQueue = (queue) => buildLinesFromSelection({
  charges: queue.finalCharges ?? queue.selectedCharges,
  procedures: queue.finalProcedures ?? queue.selectedProcedures,
  supplies: queue.finalSupplies,
});

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

/** GET /api/billing/invoices */
const list = action('Billing.invoices.list', async (req, res) => {
  const where = {};

  if (req.query.status) where.status = req.query.status.split(',');
  if (req.query.outstanding === 'true') where.status = OUTSTANDING_STATUSES;
  if (req.query.patientId) where.PatientId = Number(req.query.patientId);
  if (req.query.q) where.invoiceNumber = { [Op.like]: `%${req.query.q}%` };

  // Dates arrive as clinic-local 'YYYY-MM-DD'; clinicMidnight turns them into
  // the instants that bound that day, rather than UTC's version of it.
  if (req.query.from || req.query.to) {
    where.createdAt = {};
    if (req.query.from) where.createdAt[Op.gte] = clinicMidnight(req.query.from);
    // Half-open: everything up to the START of the following day, so the whole
    // of `to` is included rather than only its first instant.
    if (req.query.to) where.createdAt[Op.lt] = clinicMidnight(nextClinicDate(req.query.to));
  }

  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const rows = await Invoice.findAll({
    where,
    include: LIST_INCLUDES,
    order: [['createdAt', 'DESC']],
    limit,
  });

  return success(res, rows);
});

/** GET /api/billing/invoices/:id — with lines and payments, for the detail view. */
const getOne = action('Billing.invoices.get', async (req, res) => {
  const invoice = await Invoice.findByPk(req.params.id, { include: DETAIL_INCLUDES() });
  if (!invoice) throw new BillingError('Invoice not found', 404);
  return success(res, invoice);
});

/**
 * GET /api/billing/invoices/for-queue/:queueId
 *
 * The live bill for a visit, or null if none has been opened. The checkout
 * calls this first so reopening the modal shows the draft already in progress
 * rather than starting a second one.
 */
const getForQueue = action('Billing.invoices.forQueue', async (req, res) => {
  const invoice = await Invoice.findOne({
    where: { activeForQueueId: Number(req.params.queueId) },
    include: DETAIL_INCLUDES(),
  });
  return success(res, invoice || null);
});

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/** POST /api/billing/invoices — a blank or explicitly-lined draft. */
const create = action('Billing.invoices.create', async (req, res) => {
  const { PatientId, QueueId = null, lines = [], payerType, customerName, customerPin, notes } = req.body;

  const invoice = await createDraft({
    PatientId, QueueId, lines, payerType, customerName, customerPin, notes,
  });

  return success(res, await findInvoice(invoice.id), 201);
});

/**
 * POST /api/billing/invoices/from-queue/:queueId
 *
 * Open the checkout: build a draft from what the visit recorded. Idempotent —
 * if a live bill already exists for the visit it is returned rather than a
 * second one being attempted, so a double-click at the desk is harmless.
 */
const createFromQueue = action('Billing.invoices.fromQueue', async (req, res) => {
  const queueId = Number(req.params.queueId);

  const existing = await Invoice.findOne({ where: { activeForQueueId: queueId } });
  if (existing) return success(res, await findInvoice(existing.id));

  const queue = await Queue.findByPk(queueId);
  if (!queue) throw new BillingError('Visit not found', 404);
  if (!queue.PatientId) throw new BillingError('This visit has no patient attached');

  const lines = await buildLinesFromQueue(queue);
  const invoice = await createDraft({ PatientId: queue.PatientId, QueueId: queueId, lines });

  return success(res, await findInvoice(invoice.id), 201);
});

/** PUT /api/billing/invoices/:id — edit a draft's lines and payer. */
const update = action('Billing.invoices.update', async (req, res) => {
  const { lines, payerType, customerName, customerPin, notes } = req.body;
  const invoice = await updateDraft(req.params.id, {
    lines, payerType, customerName, customerPin, notes,
  });
  return success(res, await findInvoice(invoice.id));
});

/**
 * PUT /api/billing/invoices/:id/selection
 *
 * Re-price a draft from what the checkout screen currently shows: the charges
 * and procedures still ticked, and the supplies scanned so far.
 *
 * The screen sends its selection rather than a set of priced lines, so the
 * label-to-price mapping and every VAT decision stay on the server. The desk
 * gets the authoritative total back and displays it — it never computes one.
 */
const updateSelection = action('Billing.invoices.selection', async (req, res) => {
  const { charges, procedures, supplies } = req.body;
  const lines = await buildLinesFromSelection({ charges, procedures, supplies });
  const invoice = await updateDraft(req.params.id, { lines });
  return success(res, await findInvoice(invoice.id));
});

/** POST /api/billing/invoices/:id/issue */
const issue = action('Billing.invoices.issue', async (req, res) => {
  const invoice = await issueInvoice(req.params.id, { userId: req.user.id });
  return success(res, await findInvoice(invoice.id));
});

/** POST /api/billing/invoices/:id/void */
const cancel = action('Billing.invoices.void', async (req, res) => {
  const invoice = await voidInvoice(req.params.id, {
    userId: req.user.id,
    reason: req.body.reason,
  });
  return success(res, await findInvoice(invoice.id));
});

/** DELETE /api/billing/invoices/:id — discard a draft (never an issued bill). */
const discard = action('Billing.invoices.discard', async (req, res) => {
  await discardDraft(req.params.id);
  return success(res, { message: 'Draft discarded' });
});

/**
 * POST /api/billing/invoices/rebuild-totals — admin only.
 *
 * Recompute every invoice from its lines and payments. If this reports changes,
 * something wrote a total outside the ledger and that is the bug to find.
 */
const rebuildTotals = action('Billing.invoices.rebuild', async (req, res) => {
  const result = await rebuildInvoiceTotals();
  return success(res, result);
});

module.exports = {
  list,
  getOne,
  getForQueue,
  create,
  createFromQueue,
  update,
  updateSelection,
  issue,
  cancel,
  discard,
  rebuildTotals,
  // Exported for the checkout flow and for tests.
  buildLinesFromSelection,
  buildLinesFromQueue,
};
