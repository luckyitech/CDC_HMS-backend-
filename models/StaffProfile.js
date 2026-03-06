const { defineModel, DataTypes } = require('../utils/defineModel');

const StaffProfile = defineModel('StaffProfile', {
  // userId is added automatically by the association in index.js
  position: {
    type: DataTypes.STRING,
  },
  department: {
    type: DataTypes.STRING,
  },
  shift: {
    type: DataTypes.STRING, // Morning, Afternoon, Rotating
  },
  startDate: {
    type: DataTypes.DATE,
  },
});

module.exports = StaffProfile;
