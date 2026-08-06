const { defineModel, DataTypes } = require('../utils/defineModel');
const { moneyField } = require('../utils/money');
const { PAYMENT_METHOD_VALUES, PAYMENT_TYPE_VALUES } = require('../constants/billing');

// The money ledger — append-only, exactly like StockMovement.
//
// Rows are NEVER updated or deleted. A mis-keyed amount, a payment against the
// wrong invoice, a cheque that bounced: all corrected by writing a 'reversal'
// row that points at the original. What actually happened at the desk stays
// readable forever, which is the difference between a cash system an auditor
// trusts and one they don't.
//
// NOTHING HERE PROCESSES A PAYMENT. The card was authorised by the bank's POS
// terminal and the M-Pesa was confirmed by Safaricom, both outside this system.
// These rows RECORD money that has already moved, together with the reference
// that reconciles it against the statement later.
const Payment = defineModel('Payment', {
  // 'RCT-2026-001'. Reversals and refunds get their own number so they can be
  // printed and handed over as a credit note.
  receiptNumber: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },

  // 'payment' | 'refund' | 'reversal' — carries the DIRECTION of the money.
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'payment',
    validate: { isIn: [PAYMENT_TYPE_VALUES] },
  },

  // 'cash' | 'mpesa' | 'card' | 'insurance' | 'bank'. STRING so a new method
  // is a row in PAYMENT_METHODS, not a migration.
  method: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { isIn: [PAYMENT_METHOD_VALUES] },
  },

  // ALWAYS POSITIVE. Direction comes from `type`, never from the sign — the
  // same rule as StockMovement.quantity. A signed column invites a negative
  // payment that no validator rejects and every SUM silently believes.
  amountMinor: {
    ...moneyField('amountMinor'),
    validate: { min: 1 },
  },

  // The proof that reconciles this against an external statement: the M-Pesa
  // code, the terminal auth code, the bank transfer reference, the claim
  // number. Required for every method except cash — see PAYMENT_METHODS.
  reference: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // The guarded form of `reference`, as 'method:REFERENCE', written ONLY for
  // methods whose reference is genuinely unique (M-Pesa, bank). Unique-indexed,
  // so the same M-Pesa code can never be banked twice — a real risk when a
  // receptionist retries a submission that already succeeded.
  //
  // Card auth codes are deliberately excluded: they are short, repeat across
  // terminals and days, and guarding them would reject honest payments.
  // Null for unguarded methods, and MySQL lets NULLs repeat freely.
  uniqueReference: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    unique: true,
  },

  // Last four digits of the card, and nothing else, ever. Never the full
  // number, the expiry or the CVV — storing any of those drags the clinic into
  // PCI DSS scope for no benefit, because the terminal already handled the card
  // and this row only needs to identify which slip it matches.
  cardLast4: {
    type: DataTypes.STRING(4),
    defaultValue: null,
  },

  // Who is paying, when it is not the patient. The member number repeats on
  // every visit by design, which is precisely why it is here and not in
  // `reference` — the unique index would reject the patient's second visit.
  insuranceScheme: { type: DataTypes.STRING, defaultValue: null },
  insuranceMemberNo: { type: DataTypes.STRING, defaultValue: null },

  receivedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },

  // Required for refunds and reversals — money handed back or unwound always
  // has to say why.
  reason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  // --- The gateway seam ---
  // Unused today: every payment is 'manual', keyed by a person reading a
  // confirmation SMS or a terminal slip. If Daraja STK push is added later, the
  // callback fills these and sets source='gateway' — the same row, the same
  // ledger, the same reports. Nothing downstream has to change.
  source: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'manual',
    validate: { isIn: [['manual', 'gateway']] },
  },
  gatewayRef: { type: DataTypes.STRING, defaultValue: null },
  gatewayStatus: { type: DataTypes.STRING, defaultValue: null },
  confirmedAt: { type: DataTypes.DATE, defaultValue: null },

  // invoiceId, receivedById, reversesPaymentId — aliased associations in
  // models/index.js.
}, {
  indexes: [
    { fields: ['invoiceId'], name: 'idx_payments_invoice' },
    // The cash-up report: everything taken on a given day, by method.
    { fields: ['receivedAt', 'method'], name: 'idx_payments_received_method' },
    // uniqueReference's unique index comes from the field-level `unique: true`
    // above — declaring it here too would name an index the migration does not
    // create.
    //
    // A payment may be reversed at most ONCE. Enforced here rather than by a
    // read-then-write check in reversePayment, which two concurrent reversals
    // can both pass under REPEATABLE READ — crediting the patient twice for one
    // payment. Ordinary payments hold NULL and are unaffected. Identical
    // reasoning to unique_reversal_per_movement on StockMovement.
    { fields: ['reversesPaymentId'], unique: true, name: 'unique_reversal_per_payment' },
  ],
});

module.exports = Payment;
