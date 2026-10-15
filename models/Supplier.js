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
  // Read from the invoice when a supplier is added while receiving (15 Oct 2026).
  address: {
    type: DataTypes.STRING(255),
    defaultValue: null,
  },
  taxPin: {                     // KRA PIN as printed
    type: DataTypes.STRING(40),
    defaultValue: null,
  },
  notes: {                      // website, contact person, anything else read
    type: DataTypes.STRING(255),
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
