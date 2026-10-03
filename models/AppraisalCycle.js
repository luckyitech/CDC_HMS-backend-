const { defineModel, DataTypes } = require('../utils/defineModel');

// The clinic-wide appraisal window for a year (HR Tier 3 Phase 5, T3-9 a).
// One per year. open → closed (and back, by an All-staff runner); a closed
// cycle is read-only for everyone.
const AppraisalCycle = defineModel('AppraisalCycle', {
  year:        { type: DataTypes.INTEGER, allowNull: false },
  name:        { type: DataTypes.STRING(80), allowNull: false },
  selfDueOn:   { type: DataTypes.DATEONLY, allowNull: true },
  reviewDueOn: { type: DataTypes.DATEONLY, allowNull: true },
  status:      { type: DataTypes.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
  closedAt:    { type: DataTypes.DATE, allowNull: true },
  closedById:  { type: DataTypes.INTEGER, allowNull: true },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = AppraisalCycle;
