const { defineModel, DataTypes } = require('../utils/defineModel');

// One person's onboarding checklist (HR Tier 3 Phase 3; migration
// 20260928000012). The person is the association-generated UserId. At most one
// OPEN checklist per person (services/onboarding enforces it). `complete` is
// set when every active item is done (O-5); `closed` = HR closed it early with
// a note. Kept for the record — never deleted.
const OnboardingChecklist = defineModel('OnboardingChecklist', {
  status:      { type: DataTypes.ENUM('open', 'complete', 'closed'), allowNull: false, defaultValue: 'open' },
  role:        { type: DataTypes.STRING(20), allowNull: true },
  startDate:   { type: DataTypes.DATEONLY, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  closedNote:  { type: DataTypes.STRING(500), allowNull: true },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
  closedById:  { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = OnboardingChecklist;
