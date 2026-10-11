const { defineModel, DataTypes } = require('../utils/defineModel');

// One section of a consultation note — Presenting complaint, Past medical
// history, Allergies … (10 Oct 2026; utils/noteSections.js is the vocabulary).
// Its ticks (chips / pill rows / medicines) are ConsultationNoteSectionItems.
// Rows go with their note: deleting the note deletes them (migration …029).
const ConsultationNoteSection = defineModel('ConsultationNoteSection', {
  // ConsultationNoteId — added by ConsultationNote.hasMany(ConsultationNoteSection)
  // PatientId — the note's (canonical) patient, kept here so "the last time
  // this section was written for this patient" is one indexed read
  PatientId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  key: {
    type: DataTypes.STRING(40),   // utils/noteSections SECTION_KEYS
    allowNull: false,
  },
  position: {
    type: DataTypes.INTEGER,      // clinical order (utils/noteSections)
    allowNull: false,
    defaultValue: 0,
  },
  html: {
    type: DataTypes.TEXT,         // sanitised: bold / italic / underline / highlight / lists only
    allowNull: false,
    defaultValue: '',
  },
  text: {
    type: DataTypes.TEXT,         // the plain-text copy (ticks + html as text)
    allowNull: false,
    defaultValue: '',
  },
  // "Reviewed — no change": carried forward and signed off unchanged
  reviewed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // the section this one was pre-filled from (provenance), if any
  carriedFromSectionId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
});

module.exports = ConsultationNoteSection;
