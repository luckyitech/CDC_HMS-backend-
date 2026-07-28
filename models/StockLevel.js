const { defineModel, DataTypes } = require('../utils/defineModel');

// Current quantity per batch per location — a materialized convenience updated
// in the same DB transaction as each StockMovement insert. The ledger stays
// authoritative; POST /api/stock/levels/rebuild recomputes this table from it.
const StockLevel = defineModel('StockLevel', {
  // stockBatchId / locationId — aliased associations in models/index.js
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  indexes: [
    { fields: ['stockBatchId', 'locationId'], unique: true, name: 'unique_stock_level_batch_location' },
    { fields: ['locationId'], name: 'idx_stock_levels_location' },
  ],
});

module.exports = StockLevel;
