const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per product the clinic stocks (not per box, not per batch).
// Medications link to CatalogItem so there is one source of truth for what a
// drug is called.
const StockItem = defineModel('StockItem', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,      // e.g. "Branula 22G", "Actrapid 100IU/ml vial"
  },
  // 'medication' | 'consumable' | 'fluid' | 'dressing' | 'sharps' |
  // 'diagnostic' | 'other' — STRING so the clinic can add categories freely.
  category: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // catalogItemId — aliased association in models/index.js (set for medications)

  // The unit stock is counted in: 'vial', 'piece', 'bottle', 'box', 'pack'.
  unit: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Units per supplier pack — intake convenience ("received 3 boxes of 100").
  packSize: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  // Manufacturer barcode — scanning the retail box at intake selects the item.
  gtin: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Insulin, GLP-1 agents — only fridge locations may hold these.
  requiresColdChain: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Visual warning banner on dispense (insulin, KCl, …).
  isHighAlert: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Clinic-wide threshold driving the reorder report.
  reorderLevel: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  reorderQuantity: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  // 'active' | 'retired' — soft delete, never destroy().
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'active',
  },
  // addedById / lastUpdatedById — aliased associations in models/index.js
});

module.exports = StockItem;
