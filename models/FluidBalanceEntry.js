const { defineModel, DataTypes } = require('../utils/defineModel');

// Intake / output tracking during an admission. Running balance computed per
// shift/day from these rows. Same shape/conventions as InpatientObservation.
const FluidBalanceEntry = defineModel('FluidBalanceEntry', {
  // AdmissionId, PatientId — association-generated
  recordedAt:   { type: DataTypes.DATE,    allowNull: false },
  recordedById: { type: DataTypes.INTEGER, allowNull: true },
  direction:    { type: DataTypes.ENUM('Intake', 'Output'), allowNull: false },
  type:         { type: DataTypes.STRING,  allowNull: true },   // 'Oral', 'IV', 'Urine', 'Drain', ...
  volumeMl:     { type: DataTypes.INTEGER, allowNull: false },
  notes:        { type: DataTypes.TEXT,    allowNull: true },
  status:       { type: DataTypes.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
});

module.exports = FluidBalanceEntry;
