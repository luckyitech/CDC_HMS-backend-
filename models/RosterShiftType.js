const { defineModel, DataTypes } = require('../utils/defineModel');

// A shift HR defines for the whole clinic (HR Tier 3 Phase 4, T3-7 a, RO-1):
// a name, a start and an end, and a colour for the week grid. A shift whose
// end is at or before its start runs past midnight (a night shift). Archived,
// never deleted — a cell copies the times, so editing a type never rewrites a
// week already rostered. Migration 20260928000013.
const RosterShiftType = defineModel('RosterShiftType', {
  name:        { type: DataTypes.STRING(40), allowNull: false },
  startTime:   { type: DataTypes.TIME, allowNull: false },
  endTime:     { type: DataTypes.TIME, allowNull: false },
  colour:      { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'blue' },
  sortOrder:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status:      { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = RosterShiftType;
