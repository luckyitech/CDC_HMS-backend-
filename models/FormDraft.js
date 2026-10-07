const { defineModel, DataTypes } = require('../utils/defineModel');

// An autosaved, NOT-YET-SAVED form (migration 20260928000019). One row per
// author × patient × form × context. Not part of the medical record:
//   - only its author (userId, from the JWT) ever reads it;
//   - it is deleted the moment the real save succeeds (the form's own code
//     calls DELETE /api/drafts), and by services/draftSweep after 14 days
//     untouched (a bell reminder goes out once, on day 12);
//   - payload is the form's own state, stored as JSON TEXT (read through
//     utils/formDrafts.readPayload — never a JSON column, so MariaDB and
//     MySQL 8 hand back the same thing).
// PatientId is the canonical patient (family.patient.id); reads use the
// merge family.
const FormDraft = defineModel('FormDraft', {
  userId:         { type: DataTypes.INTEGER, allowNull: false },
  formKey:        { type: DataTypes.STRING(64), allowNull: false },
  contextKey:     { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
  label:          { type: DataTypes.STRING(120), allowNull: true },
  payload:        { type: DataTypes.TEXT('long'), allowNull: false },
  device:         { type: DataTypes.STRING(60), allowNull: true },
  reminderSentAt: { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { name: 'uq_form_draft_owner_form', unique: true, fields: ['userId', 'PatientId', 'formKey', 'contextKey'] },
    { name: 'idx_form_draft_updated', fields: ['updatedAt'] },
  ],
});

module.exports = FormDraft;
