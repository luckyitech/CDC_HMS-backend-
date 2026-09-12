const { defineModel, DataTypes } = require('../utils/defineModel');

// A doctor's per-patient override of the consensus glucose targets
// (constants/glucose.js CONSENSUS_TARGETS). One row per patient; absent means
// "consensus". Every null column falls through to the consensus value, so a
// doctor can change only the in-range band and leave everything else.
//
// A rationale is mandatory and the summary endpoint prints "targets:
// individualised — set by Dr X on <date>: <rationale>" beside every metric it
// affects, so nobody reads a 50 % TIR as "on target" without seeing why the
// bar was moved.

const PatientGlucoseTarget = defineModel('PatientGlucoseTarget', {
  // PatientId — added by Patient.hasOne(PatientGlucoseTarget); unique
  // setById   — belongsTo(User, { as: 'setBy' })

  preset:          { type: DataTypes.STRING(32), defaultValue: null },
  tirLowMgdl:      { type: DataTypes.SMALLINT, defaultValue: null },
  tirHighMgdl:     { type: DataTypes.SMALLINT, defaultValue: null },
  tbrLevel2Mgdl:   { type: DataTypes.SMALLINT, defaultValue: null },
  tarLevel2Mgdl:   { type: DataTypes.SMALLINT, defaultValue: null },
  fastingLowMgdl:  { type: DataTypes.SMALLINT, defaultValue: null },
  fastingHighMgdl: { type: DataTypes.SMALLINT, defaultValue: null },
  cvTargetPct:     { type: DataTypes.TINYINT,  defaultValue: null },
  tirGoalPct:      { type: DataTypes.TINYINT,  defaultValue: null },
  tbrGoalPct:      { type: DataTypes.TINYINT,  defaultValue: null },
  tarGoalPct:      { type: DataTypes.TINYINT,  defaultValue: null },
  rationale:       { type: DataTypes.STRING(255), allowNull: false },
  setAt:           { type: DataTypes.DATE, allowNull: false },
});

module.exports = PatientGlucoseTarget;
