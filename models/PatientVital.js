const { defineModel, DataTypes } = require('../utils/defineModel');

const PatientVital = defineModel('PatientVital', {
  // patientId is added automatically by the association in index.js

  bp: {
    type: DataTypes.STRING,     // "120/80" — stored without units
  },
  heartRate: {
    type: DataTypes.INTEGER,
  },
  temperature: {
    type: DataTypes.DECIMAL(3, 1),
  },
  weight: {
    type: DataTypes.DECIMAL(5, 1),   // kg
  },
  height: {
    type: DataTypes.DECIMAL(4, 1),   // cm
  },
  bmi: {
    type: DataTypes.DECIMAL(4, 1),   // calculated by controller: weight / (height/100)²
  },
  oxygenSaturation: {
    type: DataTypes.INTEGER,         // percentage
  },
  waistCircumference: {
    type: DataTypes.DECIMAL(4, 1),   // cm
  },
  waistHeightRatio: {
    type: DataTypes.DECIMAL(4, 2),   // calculated by controller: waist / height
  },

  // --- Optional triage fields ---
  rbs: {
    type: DataTypes.DECIMAL(5, 1),   // Random Blood Sugar — not always recorded
    defaultValue: null,
  },
  hba1c: {
    type: DataTypes.DECIMAL(3, 1),
    defaultValue: null,
  },
  ketones: {
    type: DataTypes.DECIMAL(4, 2),
    defaultValue: null,
  },
  chiefComplaint: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  recordedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,     // auto-set to current timestamp
  },
});

module.exports = PatientVital;
