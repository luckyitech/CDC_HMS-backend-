const { defineModel, DataTypes } = require('../utils/defineModel');

// A scanned page (photo or PDF) of a StockReceipt (12 Oct 2026). Stored under
// private/stock-receipts/ with a random name — never served statically; read
// only through GET /api/stock/receipts/:id/documents/:docId (stock.access).
// Removal is soft (status 'removed', with who and when): it is audit evidence.
const StockReceiptDocument = defineModel('StockReceiptDocument', {
  // stockReceiptId / uploadedById / removedById — aliased associations in models/index.js
  filePath: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  mimeType: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  fileSize: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
  },
  removedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
});

module.exports = StockReceiptDocument;
