const { defineModel, DataTypes } = require('../utils/defineModel');

// Photography consent for the skin record (Dermatology Phase 2, migration
// 20260928000022). Append-only: each row is what the patient said at that
// moment; the newest row across the merge family is the current answer, and
// the older ones are its history. `clinical` = photos for the medical record
// (required before any photo is taken); `teaching` = may be used for teaching
// (recorded only — nothing in the HMS uses photos for teaching).
// PatientId is the canonical patient; recordedById from the JWT.
const DermConsent = defineModel('DermConsent', {
  clinical:     { type: DataTypes.BOOLEAN, allowNull: false },
  teaching:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  note:         { type: DataTypes.STRING(500), allowNull: true },
  recordedById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  updatedAt: false,
  indexes: [{ name: 'idx_derm_consent_patient', fields: ['PatientId', 'createdAt'] }],
});

module.exports = DermConsent;
