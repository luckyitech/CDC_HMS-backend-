const { defineModel, DataTypes } = require('../utils/defineModel');

// A staff member asking HR to change a field they may not edit themselves —
// name, National ID, date of birth, licence or qualification details (B27,
// migration 20260928000005; decision D11). Decided by hr.profile.approve in
// phase 4. Never deleted: withdrawn and rejected are statuses.
//
// Association-injected: UserId (the person), decidedById, attachmentDocumentId.
const StaffChangeRequest = defineModel('StaffChangeRequest', {
  field:        { type: DataTypes.STRING(60), allowNull: false },
  oldValue:     { type: DataTypes.TEXT, allowNull: true },
  newValue:     { type: DataTypes.TEXT, allowNull: true },
  reason:       { type: DataTypes.TEXT, allowNull: true },
  status:       { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'withdrawn'), allowNull: false, defaultValue: 'pending' },
  decidedAt:    { type: DataTypes.DATE, allowNull: true },
  decisionNote: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = StaffChangeRequest;
