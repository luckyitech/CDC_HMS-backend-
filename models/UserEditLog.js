const { defineModel, DataTypes } = require('../utils/defineModel');

const UserEditLog = defineModel('UserEditLog', {
  targetUserId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  editedBy: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  editedByName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  changes: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  editedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

module.exports = UserEditLog;
