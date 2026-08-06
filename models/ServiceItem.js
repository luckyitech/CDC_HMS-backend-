const { defineModel, DataTypes } = require('../utils/defineModel');
const { moneyField } = require('../utils/money');
const {
  VAT_CLASS_VALUES, DEFAULT_VAT_CLASS, SERVICE_CATEGORY_VALUES,
} = require('../constants/billing');

// The price list — every billable thing the clinic sells, and what it costs.
//
// Replaces the hardcoded CHARGE_OPTIONS / PROCEDURE_OPTIONS arrays that lived
// in the frontend, so adding a service becomes an admin action rather than a
// deploy. The doctor's tick-list is fetched from this table; reception bills
// from it; the invoice line snapshots it.
//
// Retired, never deleted — an item that has ever been billed must stay
// resolvable for as long as its invoices exist. Same rule as StockItem.
const ServiceItem = defineModel('ServiceItem', {
  // Optional short code for the price list and receipts ('CONS', 'HBA1C').
  // Nullable and unique: MySQL permits repeated NULLs, so codes are opt-in.
  code: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    unique: true,
  },
  // What the doctor ticks and what prints on the bill. Unique because the
  // checkout resolves a visit's charge labels back to price list rows by name.
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  // STRING not ENUM — the clinic gains a category without a migration, the
  // same call StockItem.category made. Validated against the constants table
  // so an unknown value is still rejected.
  category: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'other',
    validate: { isIn: [SERVICE_CATEGORY_VALUES] },
  },
  // Longer text for the invoice line when the name alone is too terse.
  description: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // NULL means NOT YET PRICED — deliberately distinct from zero.
  //
  // The 21 services seeded from the old hardcoded lists start here, and issuing
  // an invoice containing an unpriced line is refused. Defaulting to 0 instead
  // would let the clinic hand out free consultations for as long as it took
  // someone to notice, which is exactly the failure this column exists to
  // prevent. A genuinely free service is priced 0 explicitly.
  unitPriceMinor: moneyField('unitPriceMinor', { allowNull: true, defaultValue: null }),

  // 'exempt' | 'standard' | 'zero'. STRING rather than ENUM because KRA has
  // changed the rate and code set before and will again; a new class must not
  // need a schema change. The rate itself is never stored here — it is derived
  // from the class and the clinic's configured standard rate at invoice time,
  // then snapshotted onto the line.
  vatClass: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: DEFAULT_VAT_CLASS,
    validate: { isIn: [VAT_CLASS_VALUES] },
  },

  // 'active' | 'retired' — soft delete, never destroy().
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'retired']] },
  },

  // stockItemId, addedById, lastUpdatedById — aliased associations in
  // models/index.js. stockItemId links a billable supply to the StockItem it
  // is dispensed from, so a batch scanned at checkout resolves to a price.
}, {
  indexes: [
    { fields: ['status', 'category'], name: 'idx_service_items_status_category' },
  ],
});

module.exports = ServiceItem;
