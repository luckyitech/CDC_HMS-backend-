const { defineModel, DataTypes } = require('../utils/defineModel');

// Someone the applicant chose for a leave request (B27, migration
// 20260928000003; decisions D5–D6). APPROVERS must all approve; ACKNOWLEDGERS
// are only told (decision 'notified'). The workflow rules are in
// utils/leaveWorkflow.js.
//
// Association-injected: leaveId (camelCase → StaffLeaves), UserId (PascalCase
// → Users). Indexes live in the migration.
const LeaveParticipant = defineModel('LeaveParticipant', {
  kind:      { type: DataTypes.ENUM('approver', 'acknowledger'), allowNull: false },
  decision:  { type: DataTypes.ENUM('pending', 'approved', 'declined', 'info_requested', 'notified'), allowNull: false, defaultValue: 'pending' },
  decidedAt: { type: DataTypes.DATE, allowNull: true },
  note:      { type: DataTypes.TEXT, allowNull: true },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
});

module.exports = LeaveParticipant;
