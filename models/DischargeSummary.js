const { defineModel, DataTypes } = require('../utils/defineModel');

// One per admission, always required to discharge. Auto-generated as a draft by
// aggregating the admission's doctor notes, then reviewed and signed by a
// doctor. Signing gates the discharge. AI generation plugs into the same
// draft-then-review seam later (see dischargeSummaryController.generate).
const DischargeSummary = defineModel('DischargeSummary', {
  // AdmissionId — association-generated (hasOne); PatientId denormalised
  finalDiagnoses:       { type: DataTypes.TEXT, allowNull: true },
  proceduresDone:       { type: DataTypes.TEXT, allowNull: true },
  hospitalCourse:       { type: DataTypes.TEXT, allowNull: true },
  dischargeMeds:        { type: DataTypes.JSON, allowNull: true },   // TTOs
  followUpPlan:         { type: DataTypes.TEXT, allowNull: true },
  conditionAtDischarge: {
    type: DataTypes.ENUM('Recovered', 'Improved', 'Unchanged', 'Referred', 'Deceased'),
    allowNull: true,
  },
  dischargeType: {
    type: DataTypes.ENUM('Routine', 'AgainstAdvice', 'Referred', 'Deceased', 'Absconded'),
    allowNull: true,
  },
  generatedBy: { type: DataTypes.ENUM('auto', 'ai', 'manual'), allowNull: true }, // provenance of the draft
  signedById:  { type: DataTypes.INTEGER, allowNull: true },  // doctor, JWT
  signedAt:    { type: DataTypes.DATE,    allowNull: true },
  status:      { type: DataTypes.ENUM('draft', 'signed'), allowNull: false, defaultValue: 'draft' },
});

module.exports = DischargeSummary;
