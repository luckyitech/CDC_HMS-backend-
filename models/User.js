const { defineModel, DataTypes } = require('../utils/defineModel');

const User = defineModel('User', {
  email: {
    type: DataTypes.STRING,
    allowNull: true,
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

  // --- Accountability ---
  createdBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // --- Stock module permission ---
  // Admin-granted per-user flag: staff/doctors with this see the Stocks pages.
  // authorizeStock reads it from the DB (not the JWT) so a grant takes effect
  // without re-login.
  // Superseded by `permissions` ('stock.manage'). Kept so the migration that
  // moved capabilities into `permissions` stays reversible, and because the API
  // still reports a derived canManageStock for the frontend. Nothing should
  // read this column directly — use constants/permissions.js.
  canManageStock: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Capabilities granted on top of the user's role, e.g. ['admin.access'].
  // A real admin holds all of them implicitly and stores none. See
  // constants/permissions.js for why this is an array rather than a column
  // per capability.
  permissions: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
  },
}, {
  indexes: [
    { unique: true, fields: ['email'], name: 'unique_email', where: { email: { [require('sequelize').Op.ne]: null } } },
  ],
});

module.exports = User;
