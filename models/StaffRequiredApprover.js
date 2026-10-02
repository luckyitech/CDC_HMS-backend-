const { defineModel, DataTypes } = require('../utils/defineModel');

// An approver HR has made required for one person's leave (HR Tier 2, Emu
// 2 Oct 2026; migration 20260928000009). Added as an APPROVER the person cannot
// remove on every NEW request they make; requests already sent are not changed.
// Set by leave.manage on the staff file, never on one's own file.
//
// Association-injected: UserId (PascalCase → Users, the person), approverId
// (camelCase → Users). setById = the HR user (from the JWT). Changes are logged
// in UserEditLog on the person's file.
const StaffRequiredApprover = defineModel('StaffRequiredApprover', {
  setById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  indexes: [{ unique: true, fields: ['UserId', 'approverId'], name: 'uniq_required_approver' }],
});

module.exports = StaffRequiredApprover;
