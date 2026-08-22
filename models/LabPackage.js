const { defineModel, DataTypes } = require('../utils/defineModel');

// A named bundle of lab tests the clinic commonly orders together — e.g.
// "Annual Diabetes Check-up". Membership lives in LabPackageItem (a package ↔
// CatalogItem join), kept relational rather than a JSON array so "which packages
// include test X" stays queryable.
//
// Pricing:
//   priceMode 'sum'   → the package price is the sum of its members' prices
//   priceMode 'fixed' → the package price is `fixedPrice` (a special rate)
const LabPackage = defineModel('LabPackage', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  priceMode: {
    type: DataTypes.ENUM('sum', 'fixed'),
    allowNull: false,
    defaultValue: 'sum',
  },
  fixedPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,   // used only when priceMode = 'fixed'
  },
  // Show this package as a quick-pick card in the request form.
  isCommon: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Soft-retire a package without losing it (existing requests are unaffected —
  // they snapshot packageName/packageRate at order time).
  status: {
    type: DataTypes.ENUM('active', 'archived'),
    allowNull: false,
    defaultValue: 'active',
  },
  addedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
});

module.exports = LabPackage;
