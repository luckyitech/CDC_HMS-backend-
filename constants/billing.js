// =====================================================================
// The billing vocabulary — VAT classes, payment methods, invoice statuses,
// service categories.
//
// Everything the module branches on is a lookup table here, not a literal
// scattered across controllers. Adding a payment method is a row in
// PAYMENT_METHODS; the validator, the reference rules, the cash-up report and
// the frontend picker all pick it up without another line of code. Same
// reasoning as constants/permissions.js and stockLedger's MOVEMENT_RULES.
// =====================================================================

// ---------------------------------------------------------------------
// VAT
//
// Rates are BASIS POINTS — 16% is the integer 1600, never the float 0.16.
// See utils/money.js for why no money-adjacent number here is ever a float.
//
// eTIMS reports a tax code per line, and 'exempt' and 'zero-rated' are NOT the
// same thing to KRA even though both charge nothing: exempt supplies carry no
// input-tax recovery, zero-rated ones do. Collapsing them into "rate 0" would
// produce a return that is arithmetically right and legally wrong, so the
// distinction is carried through to the invoice line.
// ---------------------------------------------------------------------
const VAT_CLASSES = {
  exempt:   { label: 'Exempt',        etimsCode: 'A', standardRated: false },
  standard: { label: 'Standard VAT',  etimsCode: 'B', standardRated: true  },
  zero:     { label: 'Zero-rated',    etimsCode: 'C', standardRated: false },
};

const VAT_CLASS_VALUES = Object.keys(VAT_CLASSES);

// Most medical services are VAT-exempt in Kenya, so this is the safe default
// for a new service item — an exempt item priced by mistake undercharges
// nobody, whereas defaulting to standard would silently add 16% to a
// consultation fee. The clinic's accountant signs off the real classification.
const DEFAULT_VAT_CLASS = 'exempt';

// Kenya's standard rate at the time of writing. Stored in Settings so a rate
// change is an admin action, not a deploy; this is only the fallback.
const DEFAULT_STANDARD_VAT_BP = 1600;

/**
 * The rate that applies to a class, given the clinic's configured standard
 * rate. The ONE place the class → rate question is answered — the ledger, the
 * price list preview and the invoice printer all call this rather than each
 * deciding what 'exempt' means.
 */
const vatRateBpFor = (vatClass, standardVatBp = DEFAULT_STANDARD_VAT_BP) =>
  VAT_CLASSES[vatClass]?.standardRated ? standardVatBp : 0;

const etimsCodeFor = (vatClass) => VAT_CLASSES[vatClass]?.etimsCode || null;

// ---------------------------------------------------------------------
// Payment methods
//
// The clinic takes card on a bank POS terminal and M-Pesa on a Paybill. Both
// settle OUTSIDE this system: the terminal authorises the card, Safaricom
// confirms the M-Pesa. Nothing here processes a payment — it records one that
// already happened, together with whatever proof reconciles it later.
//
// `reference`      'none' | 'optional' | 'required' — what reception must type.
// `uniqueReference` guards against the same external transaction being banked
//                   twice. Set ONLY where the reference is genuinely unique:
//
//   M-Pesa    a 10-character code, globally unique          → guarded
//   Bank      transaction reference, unique per transfer     → guarded
//   Card      terminal AUTH CODE — typically 6 digits and NOT unique across
//             terminals or days. Guarding it would reject a legitimate second
//             payment that happened to draw the same code, so it is not.
//   Insurance a claim number, and claims are chased and re-submitted; the
//             member number repeats on every visit by design and is stored in
//             its own column, never in `reference`.
// ---------------------------------------------------------------------
const PAYMENT_METHODS = {
  cash: {
    label: 'Cash',
    reference: 'none',
    uniqueReference: false,
  },
  mpesa: {
    label: 'M-Pesa',
    reference: 'required',
    referenceLabel: 'M-Pesa code',
    uniqueReference: true,
  },
  card: {
    label: 'Card',
    reference: 'required',
    referenceLabel: 'Terminal auth code',
    uniqueReference: false,
    // Last four digits only. Never the full number, the expiry or the CVV —
    // storing any of those puts the clinic in PCI DSS scope for no benefit,
    // since the terminal already handled the card.
    capturesCardLast4: true,
  },
  insurance: {
    label: 'Insurance',
    reference: 'optional',
    referenceLabel: 'Claim no.',
    uniqueReference: false,
    capturesInsurer: true,
  },
  bank: {
    label: 'Bank transfer',
    reference: 'required',
    referenceLabel: 'Transaction ref',
    uniqueReference: true,
  },
};

const PAYMENT_METHOD_VALUES = Object.keys(PAYMENT_METHODS);

/**
 * The value stored in Payment.uniqueReference — the column carrying the unique
 * index. Returns null for methods that are not guarded, and MySQL allows NULLs
 * to repeat in a unique index, so those rows are unaffected.
 *
 * The method is part of the key so an M-Pesa code and a bank reference cannot
 * collide with each other.
 */
const uniqueReferenceFor = (method, reference) => {
  if (!PAYMENT_METHODS[method]?.uniqueReference) return null;
  const trimmed = String(reference || '').trim().toUpperCase();
  return trimmed ? `${method}:${trimmed}` : null;
};

// ---------------------------------------------------------------------
// Payment types — the direction of the money.
//
// Payment.amountMinor is ALWAYS POSITIVE; the sign comes from the type, exactly
// as StockMovement.quantity is always positive and direction comes from the
// movement type and its locations. A signed amount column invites a negative
// payment that no validator rejects and every SUM silently believes.
// ---------------------------------------------------------------------
// `carriesOwnReference` — whether money actually moved through a channel and so
// has a confirmation of its own. A refund does: the clinic really does send
// cash back and gets a new M-Pesa code for it. A REVERSAL does not: it is an
// internal correction saying the earlier record was wrong, so demanding a
// transaction code for it would be demanding proof of a transfer that never
// happened.
const PAYMENT_TYPES = {
  payment:  { label: 'Payment',  sign:  1, reasonRequired: false, carriesOwnReference: true },
  // Money handed back to the patient — an overcharge found later, a cancelled
  // procedure already paid for.
  refund:   { label: 'Refund',   sign: -1, reasonRequired: true,  carriesOwnReference: true },
  // The correction mechanism: payment rows are append-only and never edited or
  // deleted. Mis-keyed amount, wrong invoice, wrong method — all reversed.
  reversal: { label: 'Reversal', sign: -1, reasonRequired: true,  carriesOwnReference: false },
};

const PAYMENT_TYPE_VALUES = Object.keys(PAYMENT_TYPES);

const signFor = (type) => PAYMENT_TYPES[type]?.sign || 0;

// ---------------------------------------------------------------------
// Invoice status
//
// DERIVED by the ledger from the balance, never set by a caller. A status
// column that anyone may write is a status column that will eventually
// disagree with the amounts underneath it.
// ---------------------------------------------------------------------
const INVOICE_STATUSES = {
  draft:          { label: 'Draft',      editable: true,  countsAsRevenue: false },
  issued:         { label: 'Issued',     editable: false, countsAsRevenue: true  },
  partially_paid: { label: 'Part paid',  editable: false, countsAsRevenue: true  },
  paid:           { label: 'Paid',       editable: false, countsAsRevenue: true  },
  void:           { label: 'Void',       editable: false, countsAsRevenue: false },
};

const INVOICE_STATUS_VALUES = Object.keys(INVOICE_STATUSES);

// Statuses that owe money and belong on the debtors report.
const OUTSTANDING_STATUSES = ['issued', 'partially_paid'];

// ---------------------------------------------------------------------
// Service categories — how the price list is grouped on screen and how revenue
// is broken down in reports. STRING in the schema, not ENUM, so the clinic can
// gain a category without a migration (the same call stockItems made).
// ---------------------------------------------------------------------
const SERVICE_CATEGORIES = {
  consultation: { label: 'Consultation' },
  procedure:    { label: 'Procedure' },
  laboratory:   { label: 'Laboratory' },
  injection:    { label: 'Injection' },
  supply:       { label: 'Supply' },
  other:        { label: 'Other' },
};

const SERVICE_CATEGORY_VALUES = Object.keys(SERVICE_CATEGORIES);

// ---------------------------------------------------------------------
// Settings keys — clinic-wide billing configuration, read through
// utils/billingConfig.js. Namespaced 'billing.' so they never collide with the
// catalog and rotation keys already in the Settings table.
// ---------------------------------------------------------------------
const SETTINGS = {
  STANDARD_VAT_BP:    'billing.standardVatBp',
  PRICES_INCLUDE_VAT: 'billing.pricesIncludeVat',
  CLINIC_NAME:        'billing.clinicName',
  CLINIC_PIN:         'billing.clinicPin',
  CLINIC_ADDRESS:     'billing.clinicAddress',
  VAT_REGISTERED:     'billing.vatRegistered',
};

// The currency the clinic bills in. A single-currency clinic does not need a
// rate table; this exists so the value on the invoice and the receipt comes
// from one place rather than a literal in each template.
const CURRENCY = 'KES';

module.exports = {
  VAT_CLASSES,
  VAT_CLASS_VALUES,
  DEFAULT_VAT_CLASS,
  DEFAULT_STANDARD_VAT_BP,
  vatRateBpFor,
  etimsCodeFor,

  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  uniqueReferenceFor,

  PAYMENT_TYPES,
  PAYMENT_TYPE_VALUES,
  signFor,

  INVOICE_STATUSES,
  INVOICE_STATUS_VALUES,
  OUTSTANDING_STATUSES,

  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_VALUES,

  SETTINGS,
  CURRENCY,
};
