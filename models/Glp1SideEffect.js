const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per symptom per review — a table rather than a JSON blob, so the
// clinic can answer "every patient with moderate-or-worse nausea on tirzepatide"
// in SQL, and the weekly summary grid is a GROUP BY rather than a JSON walk.
const Glp1SideEffect = defineModel('Glp1SideEffect', {
  // Glp1ReviewId  — added by Glp1Review.hasMany(Glp1SideEffect)
  // Glp1TherapyId — added by Glp1Therapy.hasMany(Glp1SideEffect); denormalised so
  //                 "all side effects on this course" needs no join
  // symptomId     — added by Glp1SideEffect.belongsTo(Glp1SideEffectCatalog, { as: 'symptom' })

  // Snapshot of the catalogue name at the time of recording. If a catalogue
  // entry is later renamed, historical reviews still read as they were written.
  symptomName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  severity: {
    type: DataTypes.ENUM('none', 'mild', 'moderate', 'severe'),
    allowNull: false,
  },
  note: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // 'patient' is reserved for between-visit reporting from the patient portal.
  source: {
    type: DataTypes.ENUM('doctor', 'patient'),
    allowNull: false,
    defaultValue: 'doctor',
  },
});

module.exports = Glp1SideEffect;
