const { defineModel, DataTypes } = require('../utils/defineModel');

// A department on the clinic's managed list (HR Tier 3 Phase 1, T3-2a;
// migration 20260928000011). Staff files pick from this list instead of typing
// free text, which is what lets reports count by department and lets an HR
// control be limited to "the Laboratory" (PermissionScope).
//
// Never deleted: archived, and only once nobody active is in it
// (services/staffLists). The name is copied onto StaffProfile.department as the
// display copy — written only by services/staffLists, so a rename reaches every
// file in the same transaction.
const Department = defineModel('Department', {
  name: { type: DataTypes.STRING(120), allowNull: false },
  status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  indexes: [{ unique: true, fields: ['name'], name: 'uniq_department_name' }],
});

module.exports = Department;
