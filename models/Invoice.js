const { defineModel, DataTypes } = require('../utils/defineModel');
const { moneyField } = require('../utils/money');
const { INVOICE_STATUS_VALUES, CURRENCY } = require('../constants/billing');

// A patient's bill for one visit.
//
// Draft while reception is building it; FROZEN the moment it is issued. An
// issued invoice and its lines are never edited — a mistake is corrected by
// voiding it (with a reason) and issuing a fresh one, which is both the
// accounting convention and what fiscalisation requires once eTIMS is on.
//
// The money columns are MATERIALIZED: they are recomputed from InvoiceLines
// and Payments inside the same transaction as any change, and can be rebuilt
// from them at any time. Same relationship StockLevel has to StockMovement —
// the lines are the truth, these are the fast read.
const Invoice = defineModel('Invoice', {
  // 'INV-2026-001', from utils/generateId's generateNumber.
  //
  // NULL until the invoice is ISSUED. A number is a commitment: once one is
  // handed to a patient the sequence has to account for it. Numbering drafts
  // instead would burn a number every time reception opened a checkout and
  // backed out, leaving gaps that look like deleted invoices to an auditor.
  invoiceNumber: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    unique: true,
  },

  // draft | issued | partially_paid | paid | void.
  //
  // DERIVED by the ledger from the balance — never set by a caller. A status
  // anyone may write is a status that eventually disagrees with the amounts
  // underneath it, and then nobody can tell which one is lying.
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'draft',
    validate: { isIn: [INVOICE_STATUS_VALUES] },
  },

  currency: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: CURRENCY,
  },

  // Whether the unit prices on this invoice's lines are VAT-INCLUSIVE.
  // Snapshotted from the clinic setting at draft time, because the answer
  // changes what every stored price MEANS. Without the snapshot, an admin
  // flipping the setting would silently reinterpret every historical invoice.
  pricesIncludeVat: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },

  // --- Amounts (see utils/money.js: integer cents, never floats) ---
  subtotalMinor: moneyField('subtotalMinor'),   // sum of line net
  discountMinor: moneyField('discountMinor'),   // sum of line discounts
  vatTotalMinor: moneyField('vatTotalMinor'),   // sum of line VAT
  totalMinor: moneyField('totalMinor'),         // what the patient owes
  amountPaidMinor: moneyField('amountPaidMinor'), // net of refunds/reversals
  balanceMinor: moneyField('balanceMinor'),     // total - paid

  // --- Who is being billed ---
  // 'patient' | 'insurer'. The patient is always recorded via PatientId; this
  // says who is expected to settle.
  payerType: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'patient',
    validate: { isIn: [['patient', 'insurer']] },
  },
  // Printed on the invoice when the payer is not the patient (an insurer, an
  // employer scheme). Null means bill the patient by name.
  customerName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // The payer's KRA PIN. Required on a tax invoice when the buyer wants to
  // claim the input tax; irrelevant for a walk-in paying cash.
  customerPin: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // --- eTIMS (KRA fiscalisation) ---
  // Modelled now, submitted by nobody yet. When the clinic registers, the
  // submission step fills these in and the receipt prints the QR; until then
  // every invoice sits at 'not_submitted' and nothing depends on it.
  etimsStatus: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'not_submitted',
    validate: { isIn: [['not_submitted', 'submitted', 'failed', 'not_applicable']] },
  },
  etimsInvoiceNo: { type: DataTypes.STRING, defaultValue: null },
  etimsSignature: { type: DataTypes.STRING, defaultValue: null },
  etimsQr: { type: DataTypes.TEXT, defaultValue: null },
  etimsSubmittedAt: { type: DataTypes.DATE, defaultValue: null },

  // --- Lifecycle ---
  issuedAt: { type: DataTypes.DATE, defaultValue: null },
  voidedAt: { type: DataTypes.DATE, defaultValue: null },
  voidReason: { type: DataTypes.TEXT, defaultValue: null },

  notes: { type: DataTypes.TEXT, defaultValue: null },

  // At most ONE live invoice per visit, enforced by the database.
  //
  // Set to the visit's QueueId on create and NULLED on void. MySQL allows
  // repeated NULLs in a unique index, so voided invoices step out of the way
  // and a corrected re-issue is possible, while two live bills for the same
  // visit are impossible. Checking in application code instead would not hold:
  // two receptionists discharging the same patient both read their snapshot
  // under REPEATABLE READ, both see no invoice, and both create one.
  //
  // Deliberately a plain INTEGER shadowing QueueId rather than a second foreign
  // key — it is a uniqueness token, not a relationship. The ledger is the only
  // thing that writes it.
  activeForQueueId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    unique: true,
  },

  // PatientId, QueueId — association-generated (Patient.hasMany, Queue.hasMany).
  // issuedById, voidedById — aliased associations in models/index.js.
}, {
  indexes: [
    { fields: ['status', 'issuedAt'], name: 'idx_invoices_status_issued' },
    { fields: ['PatientId', 'createdAt'], name: 'idx_invoices_patient_created' },
    { fields: ['QueueId'], name: 'idx_invoices_queue' },
    // activeForQueueId's unique index comes from the field-level `unique: true`
    // above — declaring it here too would name an index the migration does not
    // create.
  ],
});

module.exports = Invoice;
