const { defineModel, DataTypes } = require('../utils/defineModel');

// One leave type's rules in one year's policy (B27, migration 20260928000002).
//
//   days        allowance; null = no fixed allowance (grant 'unlimited')
//   countedAs   'working' (weekday values + holidays) or 'calendar' (every day)
//   grant       'up_front' | 'monthly' (accrues) | 'per_event' | 'unlimited'
//   docRule     'never' | 'always' | 'over_days' (docOverDays)
//
// DECIMAL columns arrive from mysql2 as strings — convert with Number() before
// doing arithmetic (utils/leaveBalance does).
//
// Association-injected: policyId, leaveTypeId (camelCase, aliased). The unique
// (policyId, leaveTypeId) index lives in the migration.
const LeavePolicyType = defineModel('LeavePolicyType', {
  days:            { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  countedAs:       { type: DataTypes.ENUM('working', 'calendar'), allowNull: false, defaultValue: 'working' },
  grant:           { type: DataTypes.ENUM('up_front', 'monthly', 'per_event', 'unlimited'), allowNull: false, defaultValue: 'up_front' },
  carryCap:        { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
  halfDaysAllowed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  docRule:         { type: DataTypes.ENUM('never', 'always', 'over_days'), allowNull: false, defaultValue: 'never' },
  docOverDays:     { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  minNoticeDays:   { type: DataTypes.INTEGER, allowNull: true },
  enabled:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
});

module.exports = LeavePolicyType;
