const { defineModel, DataTypes } = require('../utils/defineModel');

// An objective the reviewer sets for the coming year (HR Tier 3 Phase 5).
// Removed, never deleted.
const AppraisalObjective = defineModel('AppraisalObjective', {
  appraisalId: { type: DataTypes.INTEGER, allowNull: false },
  text:        { type: DataTypes.STRING(300), allowNull: false },
  dueBy:       { type: DataTypes.DATEONLY, allowNull: true },
  sortOrder:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status:      { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
  addedById:   { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = AppraisalObjective;
