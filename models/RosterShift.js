const { defineModel, DataTypes } = require('../utils/defineModel');

// One person's roster cell for one date (HR Tier 3 Phase 4). The person is the
// association-generated UserId. Either a shift (shiftTypeId + its times COPIED
// here) or Off (isOff). At most one ACTIVE cell per person per date —
// services/roster enforces it; a change removes the old cell and adds a new
// one, so the history stays (status removed).
//
// publishedAt / workHoursId: set when the cell became the person's dated
// working hours (T3-5 a) — the StaffWorkHours row it wrote. Removing a live
// cell retires that row, so the person's usual hours apply again (RO-6).
const RosterShift = defineModel('RosterShift', {
  date:        { type: DataTypes.DATEONLY, allowNull: false },
  shiftTypeId: { type: DataTypes.INTEGER, allowNull: true },
  isOff:       { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  startTime:   { type: DataTypes.TIME, allowNull: true },
  endTime:     { type: DataTypes.TIME, allowNull: true },
  status:      { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
  publishedAt: { type: DataTypes.DATE, allowNull: true },
  workHoursId: { type: DataTypes.INTEGER, allowNull: true },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
  updatedById: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = RosterShift;
