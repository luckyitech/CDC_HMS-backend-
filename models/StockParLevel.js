const { defineModel, DataTypes } = require('../utils/defineModel');

// Target range per item per room (min/max). Drives the Room Balance screen;
// only meaningful for non-store locations.
const StockParLevel = defineModel('StockParLevel', {
  // stockItemId / locationId / lastUpdatedById — aliased associations in models/index.js
  minQty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  maxQty: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  indexes: [
    { fields: ['stockItemId', 'locationId'], unique: true, name: 'unique_stock_par_item_location' },
  ],
});

module.exports = StockParLevel;
