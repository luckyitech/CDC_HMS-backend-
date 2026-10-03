const { defineModel, DataTypes } = require('../utils/defineModel');

// A competency every appraisal is rated on (HR Tier 3 Phase 5, T3-9 a —
// HR-editable). Copied by NAME into each appraisal when it starts, so editing
// or archiving one never changes an appraisal already under way. Migration
// 20260928000014 seeds four starters once.
const AppraisalCompetency = defineModel('AppraisalCompetency', {
  name:        { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.STRING(300), allowNull: true },
  sortOrder:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status:      { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = AppraisalCompetency;
