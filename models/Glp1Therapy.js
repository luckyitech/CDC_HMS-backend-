const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per patient course of a GLP-1 / GIP agonist.
// A course is never deleted — it is Stopped with a reason.
const Glp1Therapy = defineModel('Glp1Therapy', {
  // PatientId        — added by Patient.hasMany(Glp1Therapy)
  // Glp1MedicationId — added by Glp1Therapy.belongsTo(Glp1Medication)
  // doctorId         — added by Glp1Therapy.belongsTo(User, { as: 'doctor' }) — the prescriber

  indication: {
    type: DataTypes.ENUM('T2DM', 'Obesity', 'Both'),
    allowNull: false,
    defaultValue: 'T2DM',
  },
  startDate: {
    type: DataTypes.DATEONLY,      // drives current-week computation on the dose ladder
    allowNull: false,
  },
  startingDose: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: null,
  },
  targetDose: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: null,
  },
  otherConditions: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Baseline assessment block, captured once at initiation and not recomputed.
  baseline: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  // { pancreatitis, mtcMen2, giHistory, pregnancyTest, ageOverride,
  //   overrideReason, screenedBy, screenedAt }
  // Stored as answered at initiation — the record shows what was known then.
  safetyScreen: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  // Patient-scoped copy of the formulary ladder. Editing this never touches the
  // clinic default on Glp1Medication.defaultSchedule.
  doseSchedule: {
    type: DataTypes.JSON,          // [{ fromWeek, toWeek, dose, note }]
    defaultValue: null,
  },
  // Planned monitoring weeks — the standard set plus any the doctor adds.
  reviewWeeks: {
    type: DataTypes.JSON,          // [4, 8, 12, 24, 36, 52]
    defaultValue: null,
  },
  // 'standard' = the clinic's four-weekly ladder and the usual review weeks.
  // 'custom'   = doses, escalation interval and start week set for this patient,
  //              typically because they transferred in mid-therapy. Review weeks
  //              are then derived from the ladder rather than the standard set.
  regimenType: {
    type: DataTypes.ENUM('standard', 'custom'),
    allowNull: false,
    defaultValue: 'standard',
  },
  status: {
    type: DataTypes.ENUM('Active', 'Paused', 'Stopped', 'Completed'),
    allowNull: false,
    defaultValue: 'Active',
  },
  stopReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  stoppedBy: {
    type: DataTypes.INTEGER,       // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
  stoppedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // --- Agent switch ---
  // A patient moved from semaglutide to tirzepatide keeps two courses, each with
  // its own ladder and history, because they are two different drugs. This links
  // them so the tool can show the switch and when it happened.
  // switchedFromTherapyId — added by the self-referential association in index.js
  switchReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
});

module.exports = Glp1Therapy;
