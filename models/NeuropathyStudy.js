const { defineModel, DataTypes } = require('../utils/defineModel');
const { PROTOCOLS, STUDY_STATUSES, GRADES } = require('../constants/neuropathy');

// Neuropathy Studio — one row per assessment (a "study"): the plantar
// biothesiometry / thermal / monofilament exam performed in the Radiology
// portal against a Vibrotherm Dx probe (read-only capture).
//
// The individual site readings live in NeuropathyReadings (normalised — one
// row per foot × site × modality) so every analyte is SQL-queryable. The
// per-foot averages + grades below are the SERVER-COMPUTED summary written on
// `complete`; they are denormalised for fast listing/reporting and are always
// recomputable from the readings.
//
// Never hard-deleted: a study is withdrawn by status → 'Cancelled' with
// attribution (A5 — clinical records soft-delete).

const NeuropathyStudy = defineModel('NeuropathyStudy', {
  // PatientId     — added by Patient.hasMany(NeuropathyStudy)
  // performedById — added by NeuropathyStudy.belongsTo(User, { as: 'performedBy' })
  // cancelledById — added by NeuropathyStudy.belongsTo(User, { as: 'cancelledBy' })

  studyDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  protocol: {
    type: DataTypes.ENUM(...PROTOCOLS),
    allowNull: false,
    defaultValue: 'plantar',
  },
  status: {
    type: DataTypes.ENUM(...STUDY_STATUSES),
    allowNull: false,
    defaultValue: 'Draft',
  },
  referral: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // ---- per-foot summaries (computed on complete) ----
  rightVptAvg:   { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  rightVptGrade: { type: DataTypes.ENUM(...GRADES), defaultValue: null },
  leftVptAvg:    { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  leftVptGrade:  { type: DataTypes.ENUM(...GRADES), defaultValue: null },

  rightHotAvg:   { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  rightHotGrade: { type: DataTypes.ENUM(...GRADES), defaultValue: null },
  leftHotAvg:    { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  leftHotGrade:  { type: DataTypes.ENUM(...GRADES), defaultValue: null },

  rightColdAvg:   { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  rightColdGrade: { type: DataTypes.ENUM(...GRADES), defaultValue: null },
  leftColdAvg:    { type: DataTypes.DECIMAL(5, 1), defaultValue: null },
  leftColdGrade:  { type: DataTypes.ENUM(...GRADES), defaultValue: null },

  // Monofilament: tested-site count and how many were insensate, per foot.
  rightMonoTested:    { type: DataTypes.INTEGER, defaultValue: null },
  rightMonoInsensate: { type: DataTypes.INTEGER, defaultValue: null },
  leftMonoTested:     { type: DataTypes.INTEGER, defaultValue: null },
  leftMonoInsensate:  { type: DataTypes.INTEGER, defaultValue: null },

  remarks: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  impression: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Per-foot free-text interpretation (vendor Right/Left Interpretation). The
  // report auto-fills from the grades when these are blank.
  rightInterpretation: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  leftInterpretation: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  completedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // ---- report "saved once" guard ----
  // Set when the graded report PDF is first filed to Medical Documents; once
  // set, the exam UI allows view/print only (no second Save).
  reportSavedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  reportDocumentId: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },

  // ---- soft-delete attribution ----
  cancelledAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  cancelReason: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
});

module.exports = NeuropathyStudy;
