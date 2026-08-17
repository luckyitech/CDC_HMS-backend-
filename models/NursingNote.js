const { defineModel, DataTypes } = require('../utils/defineModel');

// Nursing notes in DAR format (Data, Action, Response). Each note is one row and
// the Kardex is additive — the nurse keeps appending, never overwriting. Soft
// deleted via `status` (new clinical tables never hard-delete). date/time are
// stamped by the controller at write time, in clinic time.
const NursingNote = defineModel('NursingNote', {
  // PatientId — added by Patient.hasMany(NursingNote)
  // authorId  — added by NursingNote.belongsTo(User, { as: 'author' })
  authorRole: { type: DataTypes.STRING },       // snapshot: 'nurse' | 'staff' | 'doctor' | 'admin'
  date:       { type: DataTypes.DATEONLY },
  time:       { type: DataTypes.STRING },        // "10:30 AM"
  data:       { type: DataTypes.TEXT, defaultValue: null },   // D — assessment / observation
  action:     { type: DataTypes.TEXT, defaultValue: null },   // A — what the nurse did
  response:   { type: DataTypes.TEXT, defaultValue: null },   // R — the patient's response
  status:     { type: DataTypes.ENUM('active', 'deleted'), defaultValue: 'active' },
  // Delete attribution — who removed the note and when. Same naming as
  // Glp1WeekNote. There is deliberately no updatedBy/updatedAt attribution: the
  // Kardex is append-only and exposes no update endpoint, so nothing can change
  // a note in place. Add it here if that ever changes.
  deletedBy:  { type: DataTypes.INTEGER, defaultValue: null },
  deletedAt:  { type: DataTypes.DATE, defaultValue: null },
});

module.exports = NursingNote;
