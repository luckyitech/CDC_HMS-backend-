const { defineModel, DataTypes } = require('../utils/defineModel');

// Membership row: one labTest CatalogItem belonging to one LabPackage.
// LabPackageId / CatalogItemId are added by the associations in models/index.js;
// the unique index on the pair keeps a test from being added to a package twice.
const LabPackageItem = defineModel('LabPackageItem', {}, {
  indexes: [
    { unique: true, fields: ['LabPackageId', 'CatalogItemId'], name: 'lab_package_items_unique' },
  ],
});

module.exports = LabPackageItem;
