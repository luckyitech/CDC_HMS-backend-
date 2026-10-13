const { defineModel, DataTypes } = require('../utils/defineModel');

// One correction to a received delivery line (13 Oct 2026). Append-only: the
// line shows "Edited" and every row says who, when, why and what changed.
// `changes` is [{ field, from, to }] for display only — a quantity change is
// also a 'receipt_correction' movement in the ledger.
const StockBatchEdit = defineModel('StockBatchEdit', {
  // stockBatchId / editedById — aliased associations in models/index.js
  reason: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  changes: {
    type: DataTypes.JSON,
    allowNull: false,
  },
});

module.exports = StockBatchEdit;
