const { defineModel, DataTypes } = require('../utils/defineModel');

// One department's roster for one week (Monday–Sunday) — HR Tier 3 Phase 4,
// RO-3/RO-4. departmentId NULL = staff with no department (seen only by an
// All-staff holder). draft → published, one way: nothing touches attendance
// until published; afterwards a cell change takes effect at once. minCover is
// the people-on-shift wanted per day (0 = no check; warnings only, RO-8).
// At most one row per (department, week) — services/roster enforces it.
const RosterWeek = defineModel('RosterWeek', {
  departmentId:  { type: DataTypes.INTEGER, allowNull: true },
  weekStart:     { type: DataTypes.DATEONLY, allowNull: false },
  status:        { type: DataTypes.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' },
  minCover:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  publishedAt:   { type: DataTypes.DATE, allowNull: true },
  publishedById: { type: DataTypes.INTEGER, allowNull: true },
  createdById:   { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = RosterWeek;
