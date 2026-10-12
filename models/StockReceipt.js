const { defineModel, DataTypes } = require('../utils/defineModel');

// A supplier's invoice / receipt / delivery note (12 Oct 2026, Emu). Every
// intake names one (StockBatch.stockReceiptId), and several items received
// together share it. Its scanned pages (StockReceiptDocuments) let an audit
// compare what was recorded as received with what was actually delivered.
//
// One row per supplier + number: `numberKey` is the number normalised (trimmed,
// upper-case, inner spaces collapsed) so "inv 0042" and "INV 0042" are the same
// document. Nothing is ever deleted.
const StockReceipt = defineModel('StockReceipt', {
  // supplierId / createdById — aliased associations in models/index.js

  number: {
    type: DataTypes.STRING(80),
    allowNull: false,
  },
  numberKey: {
    type: DataTypes.STRING(80),
    allowNull: false,
  },
  // 'invoice' | 'receipt' | 'delivery_note' — STRING, not ENUM.
  kind: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'invoice',
  },
}, {
  indexes: [
    { fields: ['numberKey'], name: 'idx_stock_receipts_number' },
    { fields: ['supplierId'], name: 'idx_stock_receipts_supplier' },
  ],
});

module.exports = StockReceipt;
