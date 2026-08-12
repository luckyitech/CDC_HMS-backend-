const { defineModel, DataTypes } = require('../utils/defineModel');

const UserLoginLog = defineModel('UserLoginLog', {
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Every role whose logins are recorded. Nurse and admin were missing, so
  // their logins had nowhere to go and the Activity view stayed empty for them.
  // Keep this in step with TRACKED_ROLES in services/activityLogService.js —
  // a role in that set but not this enum is silently dropped, because the
  // insert is fire-and-forget.
  role: {
    type: DataTypes.ENUM('doctor', 'staff', 'lab', 'nurse', 'admin'),
    allowNull: false,
  },
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  loginAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
});

module.exports = UserLoginLog;
