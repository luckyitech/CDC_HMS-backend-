const { defineModel, DataTypes } = require('../utils/defineModel');

// Clinic-editable indication/plan vocabularies. addedBy FK from models/index.js.
const ThyroidUsCatalogItem = defineModel('ThyroidUsCatalogItem', {
  type:      { type: DataTypes.ENUM('indication', 'plan'), allowNull: false },
  code:      { type: DataTypes.STRING, allowNull: false },
  label:     { type: DataTypes.STRING, allowNull: false },
  isActive:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
});

module.exports = ThyroidUsCatalogItem;
