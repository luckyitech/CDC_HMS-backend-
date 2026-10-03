const { defineModel, DataTypes } = require('../utils/defineModel');

// One line of one person's checklist (HR Tier 3 Phase 3; migration
// 20260928000012). Copied from the template, or added by HR for this person
// only. An automatic item (autoKey) is done while its fact holds — doneAt is
// never written for it; a manual item records who ticked it and when.
// Removed items keep their row (status 'removed').
const OnboardingItem = defineModel('OnboardingItem', {
  checklistId: { type: DataTypes.INTEGER, allowNull: false },
  label:       { type: DataTypes.STRING(160), allowNull: false },
  autoKey:     { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
  dueDate:     { type: DataTypes.DATEONLY, allowNull: true },
  sortOrder:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  doneAt:      { type: DataTypes.DATE, allowNull: true },
  doneById:    { type: DataTypes.INTEGER, allowNull: true },
  note:        { type: DataTypes.STRING(500), allowNull: true },
  status:      { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
  addedById:   { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = OnboardingItem;
