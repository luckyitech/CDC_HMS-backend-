const { defineModel, DataTypes } = require('../utils/defineModel');

// A continuing professional development entry (B27, migration 20260928000005;
// decision D12). Points toward the person's cadre target; an optional
// certificate is a StaffDocument (category 'Training Certificate'). Verified
// by HR in phase 5. Archived, never deleted.
//
// Association-injected: UserId, documentId, verifiedById.
const CpdActivity = defineModel('CpdActivity', {
  date:       { type: DataTypes.DATEONLY, allowNull: false },
  title:      { type: DataTypes.STRING(255), allowNull: false },
  provider:   { type: DataTypes.STRING(255), allowNull: true },
  category:   { type: DataTypes.ENUM('conference', 'course', 'webinar', 'workshop', 'self-study', 'other'), allowNull: false, defaultValue: 'other' },
  points:     { type: DataTypes.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
  status:     { type: DataTypes.ENUM('pending', 'verified', 'rejected', 'archived'), allowNull: false, defaultValue: 'pending' },
  verifiedAt: { type: DataTypes.DATE, allowNull: true },
  note:       { type: DataTypes.TEXT, allowNull: true },
});

module.exports = CpdActivity;
