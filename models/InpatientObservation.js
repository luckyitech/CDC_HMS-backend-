const { defineModel, DataTypes } = require('../utils/defineModel');

// Time-series nursing observations during an admission. NEWS2 score is computed
// server-side on create and FROZEN (never recomputed on stored rows). PatientId
// denormalised for merge-aware reads.
const InpatientObservation = defineModel('InpatientObservation', {
  // AdmissionId, PatientId — association-generated
  recordedAt:   { type: DataTypes.DATE,    allowNull: false },
  recordedById: { type: DataTypes.INTEGER, allowNull: true },   // nurse, JWT

  // Raw parameters
  respRate:     { type: DataTypes.INTEGER, allowNull: true },   // breaths/min
  spo2:         { type: DataTypes.INTEGER, allowNull: true },   // %
  onOxygen:     { type: DataTypes.BOOLEAN, allowNull: true },   // supplemental O2?
  systolicBP:   { type: DataTypes.INTEGER, allowNull: true },
  diastolicBP:  { type: DataTypes.INTEGER, allowNull: true },
  heartRate:    { type: DataTypes.INTEGER, allowNull: true },
  temperature:  { type: DataTypes.FLOAT,   allowNull: true },   // °C
  consciousness:{ type: DataTypes.ENUM('A', 'C', 'V', 'P', 'U'), allowNull: true }, // ACVPU
  rbs:          { type: DataTypes.FLOAT,   allowNull: true },   // capillary glucose
  painScore:    { type: DataTypes.INTEGER, allowNull: true },

  // Derived — computed server-side on create, stored for reporting
  newsScore:     { type: DataTypes.INTEGER, allowNull: true },
  newsBreakdown: { type: DataTypes.JSON,    allowNull: true },
  escalation:    { type: DataTypes.ENUM('None', 'Low', 'Medium', 'High'), allowNull: true },

  notes:  { type: DataTypes.TEXT, allowNull: true },

  // soft-delete / amendment
  status:      { type: DataTypes.ENUM('active', 'amended', 'voided'), allowNull: false, defaultValue: 'active' },
  amendedById: { type: DataTypes.INTEGER, allowNull: true },
  amendedAt:   { type: DataTypes.DATE,    allowNull: true },
});

module.exports = InpatientObservation;
