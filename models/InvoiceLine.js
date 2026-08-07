const { defineModel, DataTypes } = require('../utils/defineModel');
const { moneyField } = require('../utils/money');
const { VAT_CLASS_VALUES } = require('../constants/billing');

// One billable line on an invoice.
//
// EVERY commercial fact here is a SNAPSHOT taken when the line was created —
// the description, the unit price, the VAT class, the rate and the eTIMS code.
// None of it is read back through serviceItemId at display time.
//
// That is the whole point: the clinic raises the consultation fee in November,
// and the invoice printed in August must still say what it actually charged.
// Joining to the live price list to render an old invoice would silently
// rewrite history, and the first anyone would know is a patient holding a
// receipt that disagrees with the system.
const InvoiceLine = defineModel('InvoiceLine', {
  // What prints on the bill. Copied from the ServiceItem at creation, so
  // renaming or retiring the service later leaves this line intact.
  description: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1 },
  },

  // --- Snapshotted amounts (integer cents — see utils/money.js) ---
  // NULL means the service had no price set when this line was added. A draft
  // carries such a line so reception can see what is missing and price it;
  // issuing is refused while one remains. The computed columns below stay 0, so
  // an unpriced line contributes nothing to a total that would otherwise
  // silently understate the bill.
  unitPriceMinor: moneyField('unitPriceMinor', { allowNull: true, defaultValue: null }),
  discountMinor: moneyField('discountMinor'),
  // Computed by lineAmounts() and stored, so the printed invoice is a record
  // rather than a re-derivation that could round differently later.
  netMinor: moneyField('netMinor'),
  vatMinor: moneyField('vatMinor'),
  grossMinor: moneyField('grossMinor'),

  // --- Snapshotted tax treatment ---
  vatClass: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'exempt',
    validate: { isIn: [VAT_CLASS_VALUES] },
  },
  // The rate actually applied, in basis points. Stored rather than re-derived
  // from vatClass so a change to the clinic's standard rate cannot alter what
  // an old invoice claims to have charged.
  vatRateBp: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // 'A' | 'B' | 'C' — what eTIMS is told about this line.
  etimsTaxCode: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Display order on the printed invoice. Explicit rather than relying on id
  // order, so reception can reorder a draft.
  sortOrder: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },

  // invoiceId, serviceItemId, stockBatchId, pricedAtCheckoutById — aliased
  // associations in models/index.js.
  //
  //   pricedAtCheckoutById is set when reception typed this line's price at the
  //   desk, because the scanned supply matched no service on the price list.
  //   NULL means the price came from the price list, where an admin set it.
  //   The distinction is the whole audit: a price chosen by the person taking
  //   the money is reviewable, and one chosen by an admin is policy.
  //   serviceItemId is NULL for an ad-hoc line typed at the desk.
  //   stockBatchId ties a supply line to the batch actually dispensed, so the
  //   bill and the stock ledger can be reconciled against each other.
}, {
  indexes: [
    { fields: ['invoiceId', 'sortOrder'], name: 'idx_invoice_lines_invoice_sort' },
    { fields: ['serviceItemId'], name: 'idx_invoice_lines_service' },
  ],
});

module.exports = InvoiceLine;
