const { defineModel, DataTypes } = require('../utils/defineModel');

const PhysicalExamination = defineModel('PhysicalExamination', {
  // patientId — added by Patient.hasMany(PhysicalExamination)
  // doctorId  — added by PhysicalExamination.belongsTo(User, { as: 'doctor' })

  date: {
    type: DataTypes.DATEONLY,
  },
  time: {
    type: DataTypes.STRING,   // "10:30:00"
  },

  // Body system findings — all optional
  generalAppearance: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  cardiovascular: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  respiratory: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  gastrointestinal: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  neurological: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  musculoskeletal: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  skin: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  examFindings: {
    type: DataTypes.TEXT,     // overall summary
    defaultValue: null,
  },
  // Structured examination data (checkboxes, vitals, notes) from frontend form
  data: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  lastModified: {
    type: DataTypes.DATE,     // set by controller on update
    defaultValue: null,
  },
});

module.exports = PhysicalExamination;
