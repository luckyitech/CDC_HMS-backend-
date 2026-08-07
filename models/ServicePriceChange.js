const { defineModel, DataTypes } = require('../utils/defineModel');
const { moneyField } = require('../utils/money');
const { VAT_CLASS_VALUES } = require('../constants/billing');

// What a service used to cost, and what it costs now — one row per change.
//
// ServiceItem.lastUpdatedById answers "who touched this last". It does not
// answer "what did they change it to", and that gap is the one worth closing:
// a price can be dropped, billed against, and restored inside a few minutes,
// leaving every invoice looking perfectly ordinary and the log showing nothing
// but two edits with no amounts.
//
// Append-only. Rows are never updated or deleted — the same rule StockMovement
// and Payment follow, for the same reason: a history that can be rewritten is
// not a history.
const ServicePriceChange = defineModel('ServicePriceChange', {
  // Both sides of the change, so a row is readable on its own without having to
  // reconstruct the sequence from every row before it.
  //
  // NULL price means "not priced" — the state a seeded service starts in — and
  // is deliberately distinct from 0, which means the clinic gives it away.
  oldPriceMinor: moneyField('oldPriceMinor', { allowNull: true, defaultValue: null }),
  newPriceMinor: moneyField('newPriceMinor', { allowNull: true, defaultValue: null }),

  oldVatClass: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    validate: { isIn: [VAT_CLASS_VALUES] },
  },
  newVatClass: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    validate: { isIn: [VAT_CLASS_VALUES] },
  },

  // Retiring a service is a commercial change too: it stops being sellable.
  oldStatus: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  newStatus: { type: DataTypes.STRING, allowNull: true, defaultValue: null },

  // serviceItemId, changedById — aliased associations in models/index.js.
}, {
  indexes: [
    { fields: ['serviceItemId', 'createdAt'], name: 'idx_price_changes_service_created' },
    { fields: ['createdAt'], name: 'idx_price_changes_created' },
  ],
});

module.exports = ServicePriceChange;
