const { defineModel, DataTypes } = require('../utils/defineModel');

const DoctorProfile = defineModel('DoctorProfile', {
  // userId is added automatically by the association in index.js
  licenseNumber: {
    type: DataTypes.STRING,
  },
  specialty: {
    type: DataTypes.STRING,
  },
  subSpecialty: {
    type: DataTypes.STRING,
  },
  department: {
    type: DataTypes.STRING,
  },
  qualification: {
    type: DataTypes.STRING,
  },
  medicalSchool: {
    type: DataTypes.STRING,
  },
  yearsExperience: {
    type: DataTypes.INTEGER,
  },
  employmentType: {
    type: DataTypes.STRING,
  },
  startDate: {
    type: DataTypes.DATE,
  },
  address: {
    type: DataTypes.STRING,
  },
  city: {
    type: DataTypes.STRING,
  },
});

module.exports = DoctorProfile;
