const { Op, fn, col } = require('sequelize');
const db = require('../models');
const { generateNumber } = require('./generateId');
const { lineAmounts } = require('./money');
const { getBillingConfig } = require('./billingConfig');
const {
  vatRateBpFor, etimsCodeFor, uniqueReferenceFor, signFor,
  PAYMENT_METHODS, PAYMENT_TYPES,
} = require('../constants/billing');

const { ServiceItem, Invoice, InvoiceLine, Payment, sequelize } = db;

// =====================================================================
// The billing ledger engine — ONE code path for invoices, ONE for payments.
//
// The shape is lifted from utils/stockLedger.js, because money has the same
// requirements stock does and that design already answers them here:
//
//   - Payments are APPEND-ONLY. A row is never updated or deleted; a mistake is
//     corrected by writing a 'reversal' that points at the original.
//   - Invoice totals are MATERIALIZED. InvoiceLines and Payments are the truth;
//     the columns on Invoice are a fast read kept in step inside the same
//     transaction, and rebuildInvoiceTotals() can recompute every one of them.
//   - Guarantees that must hold under concurrency are enforced by the DATABASE
//     (unique indexes, row locks), not by read-then-write checks — two
//     receptionists working the same visit is a Tuesday, not an edge case.
//
// Nothing here processes a payment. Cards clear on the bank's POS terminal and
// M-Pesa on Safaricom's rails; these rows RECORD money that has already moved.
// =====================================================================

// Errors the controllers translate to clean 4xx responses (vs unexpected 500s).
class BillingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BillingError';
    this.statusCode = statusCode;
  }
}

// Number generation is read-max-then-insert and is NOT race-safe: two
// simultaneous discharges read the same highest number and both try to use it.
// The unique index is what actually prevents the duplicate; this is how many
// times we are willing to lose that race before giving up.
const NUMBER_RETRIES = 5;

// ---------------------------------------------------------------------
// Which unique constraint did MySQL reject?
//
// Sequelize reports the violated INDEX name, which is the column name for
// field-level uniques but a chosen name for the ones added explicitly. Callers
// pass every alias that identifies the constraint they care about, so a
// collision on some OTHER unique column is never mistaken for theirs and
// retried pointlessly.
// ---------------------------------------------------------------------
const violatedNames = (err) => new Set([
  ...(err?.errors || []).map((e) => e.path).filter(Boolean),
  ...(err?.fields ? Object.keys(err.fields) : []),
]);

const isUniqueViolation = (err, aliases) => {
  if (err?.name !== 'SequelizeUniqueConstraintError') return false;
  const violated = violatedNames(err);
  return aliases.some((alias) => violated.has(alias));
};

// ---------------------------------------------------------------------
// Execution context.
//
// Every public function takes an optional { transaction, config } so the
// checkout desk can issue an invoice, bank a payment and dispense supplies in
// ONE transaction, while a standalone call still gets its own.
//
// The config is resolved BEFORE a transaction is opened. Reading it while
// holding one would take a second connection from the pool and wait on it — the
// deadlock-under-load trap documented on suggestFefoBatch in stockLedger.js.
// It is cached for a minute, so a caller passing an external transaction
// virtually never pays for a query here; pass `config` explicitly if you want
// the guarantee.
// ---------------------------------------------------------------------
const withContext = async (ctx, fn) => {
  const config = ctx?.config || await getBillingConfig();
  if (ctx?.transaction) return fn({ config, t: ctx.transaction });
  return sequelize.transaction((t) => fn({ config, t }));
};

// ---------------------------------------------------------------------
// Input coercion. Amounts arriving here are ALREADY in minor units — the
// controllers convert with parseAmount at the HTTP edge, so nothing below ever
// sees a decimal string.
// ---------------------------------------------------------------------
const asCount = (value, label) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BillingError(`${label} must be a whole number of at least 1`);
  return n;
};

const asMinor = (value, label, { allowNull = false } = {}) => {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new BillingError(`${label} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BillingError(`${label} must be a whole number of cents, zero or more`);
  return n;
};

const trimmed = (value) => {
  const s = String(value ?? '').trim();
  return s || null;
};

const sumBy = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);

// =====================================================================
// INVOICE LINES
// =====================================================================

/**
 * Turn one client-supplied line into a stored InvoiceLine payload, snapshotting
 * everything commercial about it.
 *
 * Two shapes are accepted and deliberately share this one path:
 *   { serviceItemId, quantity, discountMinor }  — from the price list
 *   { description, unitPriceMinor, vatClass }   — ad hoc, typed at the desk
 *
 * A price list item with NO PRICE produces an unpriced line rather than an
 * error: reception needs to SEE it on the draft to know what to fix. Issuing is
 * what refuses it.
 */
const resolveLine = async (input, { config, sortOrder }, t) => {
  const quantity = asCount(input.quantity ?? 1, 'Quantity');

  let serviceItem = null;
  if (input.serviceItemId) {
    serviceItem = await ServiceItem.findByPk(input.serviceItemId, { transaction: t });
    if (!serviceItem) throw new BillingError('Service item not found', 404);
    if (serviceItem.status !== 'active') {
      throw new BillingError(`${serviceItem.name} has been retired and can no longer be billed`);
    }
  }

  const description = trimmed(input.description) || serviceItem?.name;
  if (!description) throw new BillingError('Every line needs a description');

  const vatClass = serviceItem?.vatClass || input.vatClass || 'exempt';
  const unitPriceMinor = serviceItem
    ? serviceItem.unitPriceMinor
    : asMinor(input.unitPriceMinor, 'Unit price', { allowNull: true });

  const base = {
    serviceItemId: serviceItem?.id || null,
    stockBatchId: input.stockBatchId || null,
    description,
    quantity,
    vatClass,
    sortOrder,
    // Set only when the caller priced this line by hand at the checkout desk
    // because no service was linked to the scanned item. Null means the price
    // came off the price list, where an admin set it — the distinction is what
    // makes an ad-hoc price reviewable afterwards.
    pricedAtCheckoutById: input.pricedAtCheckoutById || null,
  };

  // Unpriced: carried so it is visible, contributing nothing to the total. A
  // zero here would understate the bill silently, which is the whole reason
  // "no price" and "free" are different states.
  if (unitPriceMinor === null) {
    return {
      ...base,
      unitPriceMinor: null,
      discountMinor: 0,
      netMinor: 0,
      vatMinor: 0,
      grossMinor: 0,
      vatRateBp: 0,
      etimsTaxCode: null,
    };
  }

  const discountMinor = asMinor(input.discountMinor ?? 0, 'Discount');
  const vatRateBp = vatRateBpFor(vatClass, config.standardVatBp);

  let amounts;
  try {
    amounts = lineAmounts({
      quantity, unitPriceMinor, discountMinor, vatRateBp,
      pricesIncludeVat: config.pricesIncludeVat,
    });
  } catch (err) {
    // lineAmounts throws RangeError when the discount exceeds the line.
    throw new BillingError(`${description}: ${err.message.toLowerCase()}`);
  }

  return {
    ...base,
    unitPriceMinor,
    discountMinor,
    ...amounts,
    vatRateBp,
    etimsTaxCode: etimsCodeFor(vatClass),
  };
};

/**
 * Replace a draft's lines wholesale.
 *
 * Reception edits a basket, not individual rows, so the whole set is sent every
 * time and this is the only line-writing path. Per-line PATCH endpoints would
 * mean several round trips that can interleave, leaving a half-updated bill
 * whose total belongs to neither version.
 */
const replaceLines = async (invoice, inputs, { config, t }) => {
  assertDraft(invoice);

  if (!Array.isArray(inputs)) throw new BillingError('Lines must be a list');

  const rows = [];
  for (const [index, input] of inputs.entries()) {
    rows.push(await resolveLine(input, { config, sortOrder: index }, t));
  }

  await InvoiceLine.destroy({ where: { invoiceId: invoice.id }, transaction: t });
  if (rows.length) {
    await InvoiceLine.bulkCreate(
      rows.map((row) => ({ ...row, invoiceId: invoice.id })),
      { transaction: t }
    );
  }
};

// =====================================================================
// TOTALS
// =====================================================================

/**
 * The status an invoice's own amounts imply.
 *
 * Never accepted from a caller. A status column anyone may write is one that
 * eventually disagrees with the money underneath it, and then nothing tells you
 * which is lying.
 */
const deriveStatus = (invoice, { totalMinor, amountPaidMinor, balanceMinor }) => {
  if (invoice.status === 'void') return 'void';   // terminal
  if (invoice.status === 'draft') return 'draft'; // until issued
  // Zero-total bills ('No Charge') settle themselves — checked first so they
  // land on 'paid' rather than 'issued'.
  if (balanceMinor <= 0) return 'paid';
  if (amountPaidMinor > 0) return 'partially_paid';
  return 'issued';
};

/**
 * Recompute an invoice's materialized totals from its lines and payments.
 *
 * Called inside the same transaction as every change, so the columns can never
 * be observed disagreeing with the rows they summarise.
 */
const recalcInvoice = async (invoice, t) => {
  const [lines, payments] = await Promise.all([
    InvoiceLine.findAll({ where: { invoiceId: invoice.id }, transaction: t }),
    Payment.findAll({ where: { invoiceId: invoice.id }, transaction: t }),
  ]);

  const subtotalMinor = sumBy(lines, 'netMinor');
  const vatTotalMinor = sumBy(lines, 'vatMinor');
  const discountMinor = sumBy(lines, 'discountMinor');
  const totalMinor = sumBy(lines, 'grossMinor');

  // Refunds and reversals carry a positive amount and a negative sign — see
  // PAYMENT_TYPES. Summing the raw column would count a reversal as a payment.
  const amountPaidMinor = payments.reduce(
    (total, payment) => total + signFor(payment.type) * Number(payment.amountMinor),
    0
  );
  const balanceMinor = totalMinor - amountPaidMinor;

  await invoice.update({
    subtotalMinor,
    vatTotalMinor,
    discountMinor,
    totalMinor,
    amountPaidMinor,
    balanceMinor,
    status: deriveStatus(invoice, { totalMinor, amountPaidMinor, balanceMinor }),
  }, { transaction: t });

  return invoice;
};

// =====================================================================
// INVOICE LIFECYCLE
// =====================================================================

const assertDraft = (invoice) => {
  if (invoice.status === 'void') {
    throw new BillingError('This invoice is void — raise a new one');
  }
  if (invoice.status !== 'draft') {
    throw new BillingError(
      'This invoice has been issued and cannot be changed. Void it and raise a new one to correct it.'
    );
  }
};

const lockInvoice = async (invoiceId, t) => {
  const invoice = await Invoice.findByPk(invoiceId, { lock: t.LOCK.UPDATE, transaction: t });
  if (!invoice) throw new BillingError('Invoice not found', 404);
  return invoice;
};

/**
 * Open a draft bill.
 *
 * `QueueId` also populates activeForQueueId, whose unique index is what
 * guarantees one live invoice per visit. Two receptionists discharging the same
 * patient at once both read no invoice under REPEATABLE READ and both proceed —
 * the index is what stops the second, so its rejection is turned into the
 * message the desk needs rather than a 500.
 */
const createDraft = async ({
  PatientId, QueueId = null, lines = [],
  payerType = 'patient', customerName = null, customerPin = null, notes = null,
}, ctx) => withContext(ctx, async ({ config, t }) => {
  if (!PatientId) throw new BillingError('An invoice must belong to a patient');

  let invoice;
  try {
    invoice = await Invoice.create({
      PatientId,
      QueueId,
      activeForQueueId: QueueId,
      status: 'draft',
      currency: config.currency,
      // Snapshotted: this is what the invoice's stored prices MEAN. Without it,
      // an admin flipping the setting would reinterpret every historical bill.
      pricesIncludeVat: config.pricesIncludeVat,
      payerType,
      customerName: trimmed(customerName),
      customerPin: trimmed(customerPin)?.toUpperCase() || null,
      notes: trimmed(notes),
    }, { transaction: t });
  } catch (err) {
    if (isUniqueViolation(err, ['activeForQueueId'])) {
      throw new BillingError('This visit already has a bill open — reload the checkout to see it', 409);
    }
    throw err;
  }

  await replaceLines(invoice, lines, { config, t });
  return recalcInvoice(invoice, t);
});

/** Edit a draft: its lines and who is being billed. Refused once issued. */
const updateDraft = async (invoiceId, {
  lines, payerType, customerName, customerPin, notes, userId,
}, ctx) => withContext(ctx, async ({ config, t }) => {
  const invoice = await lockInvoice(invoiceId, t);
  assertDraft(invoice);

  const patch = {};
  if (payerType !== undefined) patch.payerType = payerType;
  if (customerName !== undefined) patch.customerName = trimmed(customerName);
  if (customerPin !== undefined) patch.customerPin = trimmed(customerPin)?.toUpperCase() || null;
  if (notes !== undefined) patch.notes = trimmed(notes);

  // Whose hands were last on this bill. The only window in an invoice's life
  // that was otherwise unattributed: issuing and voiding both record their own
  // author, and an issued invoice cannot be changed at all.
  if (userId) {
    patch.lastEditedById = userId;
    patch.lastEditedAt = new Date();
  }

  if (Object.keys(patch).length) await invoice.update(patch, { transaction: t });

  if (lines !== undefined) await replaceLines(invoice, lines, { config, t });

  return recalcInvoice(invoice, t);
});

/**
 * Issue the bill: assign its number and freeze it.
 *
 * After this the invoice and its lines are immutable. That is the accounting
 * convention and it is what fiscalisation requires — once eTIMS has signed an
 * invoice, editing it is not a thing that can happen.
 */
const issueInvoice = async (invoiceId, { userId }, ctx) => withContext(ctx, async ({ config, t }) => {
  const invoice = await lockInvoice(invoiceId, t);
  if (invoice.status === 'void') throw new BillingError('This invoice is void');
  if (invoice.status !== 'draft') throw new BillingError('This invoice has already been issued');

  const lines = await InvoiceLine.findAll({ where: { invoiceId: invoice.id }, transaction: t });
  if (!lines.length) throw new BillingError('Add at least one item before issuing this bill');

  // A null price is "nobody has decided yet", never "free". Issuing anyway
  // would hand the patient a bill that quietly omits what they were given.
  const unpriced = lines.filter((line) => line.unitPriceMinor === null);
  if (unpriced.length) {
    throw new BillingError(
      `Set a price for ${unpriced.map((l) => l.description).join(', ')} before issuing this bill`
    );
  }

  for (let attempt = 1; attempt <= NUMBER_RETRIES; attempt += 1) {
    const invoiceNumber = await generateNumber(Invoice, 'invoiceNumber', 'INV', t);
    try {
      await invoice.update({
        invoiceNumber,
        status: 'issued',
        issuedAt: new Date(),
        issuedById: userId || null,
        // A clinic that is not VAT-registered has nothing to fiscalise, and
        // saying so is more honest than leaving every invoice looking like a
        // pending submission forever.
        etimsStatus: config.vatRegistered ? 'not_submitted' : 'not_applicable',
      }, { transaction: t });
      break;
    } catch (err) {
      if (isUniqueViolation(err, ['invoiceNumber']) && attempt < NUMBER_RETRIES) continue;
      throw err;
    }
  }

  return recalcInvoice(invoice, t);
});

/**
 * Void an issued invoice — the ONLY way to correct one.
 *
 * Nulling activeForQueueId releases the visit so a corrected bill can be
 * raised: the unique index counts live invoices, and a void one is not live.
 */
const voidInvoice = async (invoiceId, { userId, reason }, ctx) => withContext(ctx, async ({ t }) => {
  const invoice = await lockInvoice(invoiceId, t);
  if (invoice.status === 'void') throw new BillingError('This invoice is already void');
  if (invoice.status === 'draft') throw new BillingError('This bill has not been issued — discard it instead');

  const why = trimmed(reason);
  if (!why) throw new BillingError('A reason is required to void an invoice');

  // Money must be unwound deliberately and visibly first. Voiding around a
  // payment would leave cash in the drawer belonging to a bill that no longer
  // exists — the reversal has to be its own recorded act.
  if (invoice.amountPaidMinor !== 0) {
    throw new BillingError(
      'This invoice has payments against it. Reverse or refund them first, then void it.'
    );
  }

  await invoice.update({
    status: 'void',
    voidedAt: new Date(),
    voidedById: userId || null,
    voidReason: why,
    activeForQueueId: null,
  }, { transaction: t });

  return invoice;
});

/**
 * Throw away a draft. Lines go with it (ON DELETE CASCADE).
 *
 * Only ever a draft: it was never numbered and never shown to a patient, so
 * there is nothing for the record to account for. An issued invoice is voided.
 */
const discardDraft = async (invoiceId, ctx) => withContext(ctx, async ({ t }) => {
  const invoice = await lockInvoice(invoiceId, t);
  assertDraft(invoice);
  await invoice.destroy({ transaction: t });
  return { discarded: true };
});

// =====================================================================
// PAYMENTS — append-only
// =====================================================================

/**
 * Validate the method-specific fields and return what should be stored.
 *
 * Driven entirely by PAYMENT_METHODS, so adding a method is a row in
 * constants/billing.js and nothing here changes.
 */
const resolveMethod = (
  { method, reference, cardLast4, insuranceScheme, insuranceMemberNo },
  { requireReference = true } = {}
) => {
  const spec = PAYMENT_METHODS[method];
  if (!spec) throw new BillingError(`Unknown payment method '${method}'`);

  const ref = trimmed(reference);
  // `requireReference` is false for a reversal, which inherits the method so the
  // cash-up nets out per channel but never moved money of its own to have a
  // confirmation code for. See carriesOwnReference in constants/billing.js.
  if (requireReference && spec.reference === 'required' && !ref) {
    throw new BillingError(`${spec.label} needs a ${spec.referenceLabel}`);
  }

  const last4 = spec.capturesCardLast4 ? trimmed(cardLast4) : null;
  if (last4 && !/^\d{4}$/.test(last4)) {
    throw new BillingError('Card digits must be the last four digits of the card');
  }

  return {
    method,
    // Cash has nothing to reconcile against, so anything typed is dropped
    // rather than stored as noise the cash-up report would have to explain.
    reference: spec.reference === 'none' ? null : ref,
    uniqueReference: uniqueReferenceFor(method, ref),
    cardLast4: last4,
    insuranceScheme: spec.capturesInsurer ? trimmed(insuranceScheme) : null,
    insuranceMemberNo: spec.capturesInsurer ? trimmed(insuranceMemberNo) : null,
  };
};

/**
 * Write one payment row and re-total the invoice — the single path every
 * payment, refund and reversal goes through.
 */
const applyPayment = async ({
  invoiceId, type = 'payment', amountMinor, receivedById, receivedAt,
  reason = null, reversesPaymentId = null, ...methodFields
}, { t }) => {
  const rules = PAYMENT_TYPES[type];
  if (!rules) throw new BillingError(`Unknown payment type '${type}'`);

  const amount = asMinor(amountMinor, 'Amount');
  if (amount < 1) throw new BillingError('Amount must be more than zero');

  const why = trimmed(reason);
  if (rules.reasonRequired && !why) throw new BillingError(`A reason is required for a ${rules.label.toLowerCase()}`);

  // The lock is the point: without it two receptionists reading the same
  // balance can both bank the full amount and the invoice ends up overpaid with
  // no record of which one was wrong.
  const invoice = await lockInvoice(invoiceId, t);
  if (invoice.status === 'draft') throw new BillingError('Issue this bill before taking payment on it');
  if (invoice.status === 'void') throw new BillingError('This invoice is void — no payment can be recorded against it');

  // Money in cannot exceed what is owed; money out cannot exceed what was
  // taken. Both are checked against the materialized columns, which the row
  // lock above has just made safe to trust.
  if (rules.sign > 0 && amount > invoice.balanceMinor) {
    throw new BillingError(
      `That is more than the outstanding balance. ${invoice.balanceMinor} cents remain on this bill.`
    );
  }
  if (rules.sign < 0 && amount > invoice.amountPaidMinor) {
    throw new BillingError('That is more than has been paid on this bill');
  }

  const stored = resolveMethod(methodFields, { requireReference: rules.carriesOwnReference });

  let payment;
  for (let attempt = 1; attempt <= NUMBER_RETRIES; attempt += 1) {
    const receiptNumber = await generateNumber(Payment, 'receiptNumber', 'RCT', t);
    try {
      payment = await Payment.create({
        ...stored,
        receiptNumber,
        invoiceId: invoice.id,
        type,
        amountMinor: amount,
        receivedById: receivedById || null,
        receivedAt: receivedAt || new Date(),
        reason: why,
        reversesPaymentId,
      }, { transaction: t });
      break;
    } catch (err) {
      if (isUniqueViolation(err, ['receiptNumber']) && attempt < NUMBER_RETRIES) continue;
      // The same external transaction being banked twice — a receptionist
      // retrying a submission that already went through.
      if (isUniqueViolation(err, ['uniqueReference'])) {
        throw new BillingError(
          `That ${PAYMENT_METHODS[stored.method].referenceLabel.toLowerCase()} has already been recorded against a bill`,
          409
        );
      }
      if (isUniqueViolation(err, ['reversesPaymentId', 'unique_reversal_per_payment'])) {
        throw new BillingError('This payment has already been reversed', 409);
      }
      throw err;
    }
  }

  await recalcInvoice(invoice, t);
  return payment;
};

/** Record money received (or handed back, with type 'refund'). */
const recordPayment = async (args, ctx) => withContext(ctx, ({ t }) => applyPayment(args, { t }));

/**
 * Reverse a payment — the ONLY correction mechanism, since payment rows are
 * immutable. Writes a mirror row for the same amount pointing at the original.
 */
const reversePayment = async (paymentId, { userId, reason }, ctx) => withContext(ctx, async ({ t }) => {
  const original = await Payment.findByPk(paymentId, { lock: t.LOCK.UPDATE, transaction: t });
  if (!original) throw new BillingError('Payment not found', 404);
  if (original.type !== 'payment') {
    throw new BillingError('Only a payment can be reversed — a refund or reversal cannot itself be reversed');
  }

  const why = trimmed(reason);
  if (!why) throw new BillingError('A reason is required to reverse a payment');

  // Fast path for the ordinary case: a clean message without waiting for the
  // database to reject the insert.
  const already = await Payment.findOne({
    where: { reversesPaymentId: original.id },
    transaction: t,
  });
  if (already) throw new BillingError('This payment has already been reversed', 409);

  // That check alone cannot be trusted. Under REPEATABLE READ two concurrent
  // reversals both read their snapshot before either commits, both see none,
  // and both proceed — crediting the patient twice for one payment. The unique
  // index on reversesPaymentId is what actually stops the second; applyPayment
  // turns its rejection into the same message this fast path gives.
  return applyPayment({
    invoiceId: original.invoiceId,
    type: 'reversal',
    // Always the full original amount. A partial reversal is not a reversal —
    // it is a refund, and it has its own type so the two never blur together.
    amountMinor: Number(original.amountMinor),
    method: original.method,
    // The original's reference is NOT copied: uniqueReference is unique, and
    // reusing an M-Pesa code here would collide with the payment being undone.
    reference: null,
    receivedById: userId || null,
    reason: why,
    reversesPaymentId: original.id,
  }, { t });
});

// =====================================================================
// ADMIN ESCAPE HATCH
// =====================================================================

/**
 * Recompute every invoice's totals from its lines and payments.
 *
 * Proof that the lines are authoritative and the columns are only a cache —
 * rebuildLevels()'s counterpart in the stock ledger. If this changes anything,
 * something wrote a total outside the engine and that is the bug to find.
 *
 * Totals are summed in SQL in two grouped passes rather than by loading every
 * line and payment ever written into memory.
 */
const rebuildInvoiceTotals = async () => sequelize.transaction(async (t) => {
  const lineSums = await InvoiceLine.findAll({
    attributes: [
      'invoiceId',
      [fn('SUM', col('netMinor')), 'net'],
      [fn('SUM', col('vatMinor')), 'vat'],
      [fn('SUM', col('discountMinor')), 'discount'],
      [fn('SUM', col('grossMinor')), 'gross'],
    ],
    group: ['invoiceId'],
    raw: true,
    transaction: t,
  });

  // Grouped by type as well, so the sign can be applied per group rather than
  // pulling every payment row back to decide it in JS.
  const paymentSums = await Payment.findAll({
    attributes: ['invoiceId', 'type', [fn('SUM', col('amountMinor')), 'total']],
    group: ['invoiceId', 'type'],
    raw: true,
    transaction: t,
  });

  const totals = new Map();
  const entry = (invoiceId) => {
    if (!totals.has(invoiceId)) {
      totals.set(invoiceId, { net: 0, vat: 0, discount: 0, gross: 0, paid: 0 });
    }
    return totals.get(invoiceId);
  };

  lineSums.forEach((row) => {
    Object.assign(entry(row.invoiceId), {
      net: Number(row.net || 0),
      vat: Number(row.vat || 0),
      discount: Number(row.discount || 0),
      gross: Number(row.gross || 0),
    });
  });
  paymentSums.forEach((row) => {
    entry(row.invoiceId).paid += signFor(row.type) * Number(row.total || 0);
  });

  const invoices = await Invoice.findAll({ transaction: t });
  let changed = 0;

  for (const invoice of invoices) {
    const sums = totals.get(invoice.id) || { net: 0, vat: 0, discount: 0, gross: 0, paid: 0 };
    const next = {
      subtotalMinor: sums.net,
      vatTotalMinor: sums.vat,
      discountMinor: sums.discount,
      totalMinor: sums.gross,
      amountPaidMinor: sums.paid,
      balanceMinor: sums.gross - sums.paid,
    };
    next.status = deriveStatus(invoice, next);

    const differs = Object.entries(next).some(([field, value]) => invoice[field] !== value);
    if (!differs) continue;

    await invoice.update(next, { transaction: t });
    changed += 1;
  }

  return { invoices: invoices.length, changed };
});

// ---------------------------------------------------------------------
// Read helper — an invoice with everything needed to render or print it.
// One include list, so every screen shows the same shape.
// ---------------------------------------------------------------------
const INVOICE_INCLUDES = () => [
  { model: InvoiceLine, as: 'lines', separate: true, order: [['sortOrder', 'ASC']] },
  { model: Payment, as: 'payments', separate: true, order: [['receivedAt', 'ASC']] },
];

const findInvoice = async (invoiceId, t = null) => {
  const invoice = await Invoice.findByPk(invoiceId, {
    include: INVOICE_INCLUDES(),
    transaction: t,
  });
  if (!invoice) throw new BillingError('Invoice not found', 404);
  return invoice;
};

module.exports = {
  BillingError,
  createDraft,
  updateDraft,
  issueInvoice,
  voidInvoice,
  discardDraft,
  recordPayment,
  reversePayment,
  recalcInvoice,
  rebuildInvoiceTotals,
  findInvoice,
  INVOICE_INCLUDES,
  // Exported for the tests and for any future caller that needs to compose a
  // billing write into a larger transaction.
  withContext,
  deriveStatus,
};
