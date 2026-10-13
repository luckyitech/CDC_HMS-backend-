const { defineModel, DataTypes } = require('../utils/defineModel');

// How a supplier writes a product on its invoices → the clinic's stock item
// (13 Oct 2026, Emu). One row per supplier + wording; written from every line
// confirmed when receiving from an invoice, so the next delivery from that
// supplier matches "GLUCOFIX STRP 50S" to "Blood glucose test strip" by itself.
// A corrected match replaces the row's item (the newest confirmation wins).
const StockSupplierAlias = defineModel('StockSupplierAlias', {
  // supplierId / stockItemId / createdById — aliased associations in models/index.js
  aliasKey: {                       // normalised wording — the lookup key
    type: DataTypes.STRING(160),
    allowNull: false,
  },
  aliasText: {                      // as read, for display
    type: DataTypes.STRING(160),
    allowNull: false,
  },
  useCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  indexes: [
    { fields: ['supplierId', 'aliasKey'], name: 'idx_stock_supplier_aliases_lookup', unique: true },
    { fields: ['stockItemId'], name: 'idx_stock_supplier_aliases_item' },
  ],
});

module.exports = StockSupplierAlias;
