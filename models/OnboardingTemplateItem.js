const { defineModel, DataTypes } = require('../utils/defineModel');

// One line of a role's onboarding template (HR Tier 3 Phase 3, T3-4 = a;
// migration 20260928000012). HR edits these at HR Suite → Onboarding →
// Templates (hr.onboarding.templates). A new checklist COPIES the role's
// active lines (a template, never a link). `autoKey` names a fact on the
// staff file that ticks the item by itself (utils/onboarding AUTO_ITEMS);
// null = HR ticks it. Never deleted — archived.
const OnboardingTemplateItem = defineModel('OnboardingTemplateItem', {
  role:      { type: DataTypes.ENUM('doctor', 'nurse', 'lab', 'staff', 'admin'), allowNull: false },
  label:     { type: DataTypes.STRING(160), allowNull: false },
  autoKey:   { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
  dueDays:   { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status:    { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
});

module.exports = OnboardingTemplateItem;
