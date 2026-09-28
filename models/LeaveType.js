const { defineModel, DataTypes } = require('../utils/defineModel');

// A kind of leave the clinic recognises (B27, migration 20260928000001).
//
// Was an ENUM on StaffLeave and LeaveBalance; now data, so HR can add a type
// without a migration. The seven original types are seeded with isSystem =
// true and cannot be retired — every leave row written before B27 names one of
// them. `key` is what StaffLeave.leaveType / LeaveCharge.leaveType /
// LeaveBalance.leaveType store; `name` is what people see.
//
// Retired, never deleted (status), so old rows keep a type to point at.
// The unique index on `key` lives in the migration.
const LeaveType = defineModel('LeaveType', {
  key:       { type: DataTypes.STRING(40), allowNull: false },
  name:      { type: DataTypes.STRING(80), allowNull: false },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  isSystem:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  status:    { type: DataTypes.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
  createdBy: { type: DataTypes.INTEGER, defaultValue: null },
  updatedBy: { type: DataTypes.INTEGER, defaultValue: null },
});

module.exports = LeaveType;
