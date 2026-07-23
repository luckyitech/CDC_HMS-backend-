const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per week that was actually recorded — given, missed or omitted.
//
// Separate from Glp1Review on purpose: a review is a clinical assessment every
// four weeks or so, an administration is a single injection, usually weekly and
// usually given by a nurse. The dose ladder describes the plan; this records
// what happened.
//
// A week with no row has simply not been recorded yet.
const Glp1Administration = defineModel('Glp1Administration', {
  // Glp1TherapyId  — added by Glp1Therapy.hasMany(Glp1Administration)
  // PatientId      — added by Patient.hasMany(Glp1Administration); denormalised
  //                  so merge-aware reads need no join
  // administeredBy — added by belongsTo(User, { as: 'administeredByUser' })

  weekNumber: {
    type: DataTypes.INTEGER,       // 0 is the starting week
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('given', 'missed', 'omitted'),
    allowNull: false,
  },
  administeredDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  dose: {
    type: DataTypes.DECIMAL(5, 2), // what was actually given, not what the ladder says
    defaultValue: null,
  },
  site: {
    type: DataTypes.STRING,        // "Left thigh", "Abdomen"
    defaultValue: null,
  },
  note: {
    type: DataTypes.TEXT,          // why it was missed or omitted
    defaultValue: null,
  },
});

module.exports = Glp1Administration;
