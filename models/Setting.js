const { defineModel, DataTypes } = require('../utils/defineModel');

// Generic key-value store for system-wide settings
// (e.g. which suggestion source each clinical catalog uses).
const Setting = defineModel('Setting', {
  key: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  value: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

module.exports = Setting;
