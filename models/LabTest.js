const { defineModel, DataTypes } = require('../utils/defineModel');

const LabTest = defineModel('LabTest', {
  // patientId   — added by Patient.hasMany(LabTest)
  // orderedById — added by LabTest.belongsTo(User, { as: 'orderedBy' })

  testNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  testType: {
    type: DataTypes.STRING,
    allowNull: false,  // HbA1c, Lipid Profile, Fasting Blood Sugar, etc.
  },
  sampleType: {
    type: DataTypes.STRING,   // Blood, Urine, etc.
  },
  priority: {
    type: DataTypes.ENUM('Routine', 'Urgent'),
    defaultValue: 'Routine',
  },
  status: {
    type: DataTypes.ENUM('Pending', 'Sample Collected', 'In Progress', 'Completed'),
    allowNull: false,
    defaultValue: 'Pending',
  },
  orderedDate: {
    type: DataTypes.DATEONLY,
  },
  orderedTime: {
    type: DataTypes.STRING,   // "10:30 AM"
  },
  sampleCollected: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  collectionDate: {
    type: DataTypes.STRING,   // "2025-01-10 11:00 AM"
    defaultValue: null,
  },

  // Flexible JSON — different fields depending on testType
  results: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  normalRange: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  interpretation: {
    type: DataTypes.STRING,   // Normal, Abnormal, Critical
    defaultValue: null,
  },
  isCritical: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  technicianNotes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  completedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  completedDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  reportGenerated: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  indexes: [
    { unique: true, fields: ['testNumber'], name: 'unique_testNumber' },
  ],
});

module.exports = LabTest;
