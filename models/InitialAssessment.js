const { defineModel, DataTypes } = require('../utils/defineModel');

const InitialAssessment = defineModel('InitialAssessment', {
  // patientId — added by Patient.hasMany(InitialAssessment)
  // doctorId  — added by InitialAssessment.belongsTo(User, { as: 'doctor' })

  date: {
    type: DataTypes.DATEONLY,
  },
  time: {
    type: DataTypes.STRING,
  },
  hpi: {
    type: DataTypes.TEXT,     // History of Present Illness
    defaultValue: null,
  },
  ros: {
    type: DataTypes.TEXT,     // Review of Systems
    defaultValue: null,
  },
  pastMedicalHistory: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  familyHistory: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  socialHistory: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Structured assessment data (checkboxes, complications, etc.) from frontend form
  data: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
});

module.exports = InitialAssessment;
