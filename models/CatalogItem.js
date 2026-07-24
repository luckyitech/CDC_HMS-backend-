const { defineModel, DataTypes } = require('../utils/defineModel');
const { DRUG_CLASS_VALUES } = require('../constants/drugClasses');

// Admin-managed clinical catalogs that power the autocomplete inputs
// (medication names on prescriptions, diagnoses on treatment plans).
// One table serves every catalog type — the type column keeps them apart.
const CatalogItem = defineModel('CatalogItem', {
  type: {
    type: DataTypes.ENUM('medication', 'diagnosis'),
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,      // medication name / diagnosis description
  },
  // Type-specific optional detail:
  //   medication → default dosage/strength, e.g. "500 mg tablet"
  //   diagnosis  → local or ICD code, e.g. "E11"
  detail: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Clinical class of a medication, chosen by the admin. Drives which clinical
  // tool a drug appears in (a GLP-1 agent shows in the GLP-1 tool). Null for
  // diagnoses and for medications with no tool association.
  drugClass: {
    type: DataTypes.ENUM(...DRUG_CLASS_VALUES),
    allowNull: true,
  },
  addedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
}, {
  indexes: [
    { fields: ['type', 'name'], unique: true, name: 'unique_catalog_type_name' },
  ],
});

module.exports = CatalogItem;
