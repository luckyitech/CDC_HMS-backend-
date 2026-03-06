const { defineModel, DataTypes } = require('../utils/defineModel');

const LabTechProfile = defineModel('LabTechProfile', {
  // userId is added automatically by the association in index.js
  specialization: {
    type: DataTypes.STRING,
  },
  certificationNumber: {
    type: DataTypes.STRING,
  },
  qualification: {
    type: DataTypes.STRING,
  },
  institution: {
    type: DataTypes.STRING,
  },
  yearsExperience: {
    type: DataTypes.INTEGER,
  },
  shift: {
    type: DataTypes.STRING,
  },
  startDate: {
    type: DataTypes.DATE,
  },
});

module.exports = LabTechProfile;
