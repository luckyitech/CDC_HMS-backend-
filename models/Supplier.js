const { defineModel, DataTypes } = require('../utils/defineModel');

// Admin-managed supplier list for stock intake. Managed as a tab in the
// Clinical Catalog area on the frontend; its own table underneath.
const Supplier = defineModel('Supplier', {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  contactPhone: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  contactEmail: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // 'active' | 'retired' — soft delete.
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'active',
  },
  // addedById / lastUpdatedById — aliased associations in models/index.js
});

module.exports = Supplier;
