const { defineModel, DataTypes } = require('../utils/defineModel');

// Clinic formulary of GLP-1 / GIP agonists. Drives the medication tabs in the
// monitoring tool — adding a row here makes the agent available to every patient.
// Writes are admin-only at the route layer.
const Glp1Medication = defineModel('Glp1Medication', {
  // addedBy — added by User.hasMany(Glp1Medication, { foreignKey: 'addedBy' })

  genericName: {
    type: DataTypes.STRING,        // e.g. "Tirzepatide"
    allowNull: false,
    unique: true,
  },
  brandName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // STRING rather than ENUM: a new class must not require a migration.
  drugClass: {
    type: DataTypes.STRING,        // "GLP-1 RA", "GIP/GLP-1 RA"
    defaultValue: null,
  },
  route: {
    type: DataTypes.STRING,        // "SC weekly"
    defaultValue: null,
  },
  strengths: {
    type: DataTypes.JSON,          // [2.5, 5, 7.5, 10, 12.5, 15]
    defaultValue: null,
  },
  // Clinic default ladder. Each patient gets an editable copy on their therapy row.
  defaultSchedule: {
    type: DataTypes.JSON,          // [{ fromWeek, toWeek, dose, note }]
    defaultValue: null,
  },
  defaultTitrationWeeks: {
    type: DataTypes.INTEGER,
    defaultValue: 4,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,            // soft-retire; formulary rows are never destroyed
  },
  addedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
});

module.exports = Glp1Medication;
