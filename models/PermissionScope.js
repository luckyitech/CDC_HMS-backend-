const { defineModel, DataTypes } = require('../utils/defineModel');

// A department limit on ONE HR control for ONE person (HR Tier 3 Phase 1,
// decisions P-1/P-7/P-8; migration 20260928000011).
//
//   no row for (person, capability)   → "All staff" (what every grant meant
//                                         before this phase — nothing changes
//                                         at deploy)
//   kind 'own'                        → the holder's own department, resolved
//                                         when it is checked, so it follows them
//                                         if they move
//   kind 'department' + departmentId  → that department (one row each)
//
// Its own table, not a JSON column, so "who can approve for the lab" can be
// answered in SQL. Written ONLY by services/hrScope.saveScopes(); read through
// services/hrScope. Association-injected: UserId (PascalCase → Users).
const PermissionScope = defineModel('PermissionScope', {
  capability: { type: DataTypes.STRING(64), allowNull: false },
  kind: { type: DataTypes.ENUM('own', 'department'), allowNull: false },
  departmentId: { type: DataTypes.INTEGER, allowNull: true },
  setById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  indexes: [
    { fields: ['UserId', 'capability'], name: 'idx_scope_user_capability' },
    { unique: true, fields: ['UserId', 'capability', 'kind', 'departmentId'], name: 'uniq_scope_row' },
  ],
});

module.exports = PermissionScope;
