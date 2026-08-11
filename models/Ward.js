const { defineModel, DataTypes } = require('../utils/defineModel');

// A physical ward. Configured by admin. Rooms and Beds hang off it.
const Ward = defineModel('Ward', {
  name:     { type: DataTypes.STRING,  allowNull: false },
  code:     { type: DataTypes.STRING,  allowNull: true  },   // short label for the board
  type:     {
    type: DataTypes.ENUM('General', 'HDU', 'Private', 'Isolation', 'Maternity'),
    allowNull: false,
    defaultValue: 'General',
  },
  ratePerDay: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 }, // bed-day charge (per midnight)
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
});

module.exports = Ward;
