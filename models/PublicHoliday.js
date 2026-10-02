const { defineModel, DataTypes } = require('../utils/defineModel');

// A public holiday (B27, migration 20260928000002; decision D4). Never counted
// as leave. HR-maintained: the fixed dates are seeded; Idd-ul-Fitr and any
// presidential declaration are added by HR when gazetted. Retired, never
// deleted. One row per date (unique index in the migration) — re-adding a
// retired date reactivates it.
//
// source 'auto' + observedForId (HR Tier 2, migration 20260928000009): the day
// a holiday that falls on a Sunday is observed — the next day that is not
// already a holiday. Written by leaveService.syncObservedDays; HR may retire
// one (a gazette that says otherwise). updatedBy null = written by the system.
const PublicHoliday = defineModel('PublicHoliday', {
  date:      { type: DataTypes.DATEONLY, allowNull: false },
  name:      { type: DataTypes.STRING(120), allowNull: false },
  status:    { type: DataTypes.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
  source:    { type: DataTypes.ENUM('seed', 'hr', 'auto'), allowNull: false, defaultValue: 'hr' },
  observedForId: { type: DataTypes.INTEGER, allowNull: true },
  createdBy: { type: DataTypes.INTEGER, defaultValue: null },
  updatedBy: { type: DataTypes.INTEGER, defaultValue: null },
});

module.exports = PublicHoliday;
