const { defineModel, DataTypes } = require('../utils/defineModel');

const User = defineModel('User', {
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  role: {
    type: DataTypes.ENUM('doctor', 'staff', 'lab', 'patient', 'admin'),
    allowNull: false,
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  resetToken: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  resetTokenExpires: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
}, {
  indexes: [
    { unique: true, fields: ['email'], name: 'unique_email' },
  ],
});

module.exports = User;
