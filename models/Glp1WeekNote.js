const { defineModel, DataTypes } = require('../utils/defineModel');

// A free-text note attached to one week of a course.
//
// Two note streams share this table and are told apart by authorRole: the
// nurse's injection note and the doctor's clinical note, both displayed against
// the same week. This is separate from Glp1Administration.note, which is the
// reason a dose was missed or omitted — a different thing on a different row.
//
// Soft delete only: status flips to 'deleted', the row stays. A correction is a
// new note plus a removal of the old one, so the record keeps the full trail
// rather than overwriting.
const Glp1WeekNote = defineModel('Glp1WeekNote', {
  // Glp1TherapyId — added by Glp1Therapy.hasMany(Glp1WeekNote)
  // PatientId     — added by Patient.hasMany(Glp1WeekNote); denormalised so
  //                 merge-aware reads work without a join through the therapy
  // authorId      — added by Glp1WeekNote.belongsTo(User, { as: 'author' })

  weekNumber: {
    type: DataTypes.INTEGER,       // 0 is the starting week
    allowNull: false,
  },
  // Snapshot of the author's role when the note was written, so the Nurse /
  // Doctor badge reads as recorded even if the user's role later changes.
  authorRole: {
    type: DataTypes.STRING,        // 'doctor' | 'staff'
    allowNull: false,
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
  },

  status: {
    type: DataTypes.ENUM('active', 'deleted'),
    allowNull: false,
    defaultValue: 'active',
  },
  deletedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
  deletedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
});

module.exports = Glp1WeekNote;
