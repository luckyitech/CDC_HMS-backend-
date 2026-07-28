const { defineModel, DataTypes } = require('../utils/defineModel');

// A delivery of one item, with its expiry. The unit of FEFO and of recall —
// every physical quantity in the system belongs to a batch.
const StockBatch = defineModel('StockBatch', {
  // stockItemId / supplierId / receivedById — aliased associations in models/index.js

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
