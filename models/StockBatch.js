const { defineModel, DataTypes } = require('../utils/defineModel');

// A delivery of one item, with its expiry. The unit of FEFO and of recall —
// every physical quantity in the system belongs to a batch.
const StockBatch = defineModel('StockBatch', {
  // stockItemId / supplierId / receivedById / stockReceiptId — aliased associations in models/index.js
  // stockReceiptId: the supplier invoice / receipt it came in on (12 Oct 2026;
  // empty for batches received before then).

  // Manufacturer lot number as printed on the box.
  batchNo: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Controller requires it for medications/dated supplies; nullable in the
  // schema for genuinely undated items.
  expiryDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  // Total units in this delivery.
  qtyReceived: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  receivedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  // Internal barcode on the printed shelf label, e.g. 'STK-000123'. The STK-
  // prefix is reserved in barcodeController's NAMESPACES table. Assigned from
  // the row id inside the intake transaction.
  labelCode: {
    type: DataTypes.STRING,
    unique: true,
    defaultValue: null,
  },
  // How the line was entered (13 Oct 2026): 'manual' (typed in Receive) or
  // 'invoice' (read from a photographed / scanned invoice and confirmed).
  receiveMethod: {
    type: DataTypes.STRING(12),
    allowNull: false,
    defaultValue: 'manual',
  },
  // Receiving from an invoice: the wording read for this line, and the fields
  // staff corrected before saving ("batchNo,expiryDate") — the audit of what
  // the reader got wrong. Both null on a manual line.
  sourceText: {
    type: DataTypes.STRING(160),
    defaultValue: null,
  },
  sourceCorrections: {
    type: DataTypes.STRING(120),
    defaultValue: null,
  },
  // 'active' | 'depleted' | 'expired' | 'recalled' — STRING, not ENUM.
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'active',
  },
}, {
  indexes: [
    { fields: ['stockItemId', 'expiryDate'], name: 'idx_stock_batches_item_expiry' },
  ],
});

module.exports = StockBatch;
