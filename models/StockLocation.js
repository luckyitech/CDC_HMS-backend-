const { defineModel, DataTypes } = require('../utils/defineModel');

// A physical place stock can sit: Main Store, Pharmacy, Dr Room 1, Fridge…
// User-addable. kind drives the room-balance screen; STRING not ENUM so new
// kinds need no migration.
const StockLocation = defineModel('StockLocation', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  // 'store' | 'doctor_room' | 'procedure_room' | 'triage' | 'fridge' | 'office'
  kind: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Only cold-chain locations may hold requiresColdChain items.
  isColdChain: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Can stock leave the building from here (vs store-only).
  isDispensing: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // 'active' | 'retired' — soft delete, never destroy().
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'active',
  },
  // addedById / lastUpdatedById — aliased associations in models/index.js
});

module.exports = StockLocation;
