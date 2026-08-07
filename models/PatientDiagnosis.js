const { defineModel, DataTypes } = require('../utils/defineModel');

/**
 * PatientDiagnosis — the patient's tracked diagnosis list (consultation summary panel).
 *
 * Clinical record: never hard-deleted. "Removing" a diagnosis retires it —
 * status flips to 'resolved' with resolvedAt/resolvedById kept for the audit trail.
 *
 * Associations (models/index.js):
 *   PatientDiagnosis.belongsTo(Patient)                       → PatientId (PascalCase)
 *   PatientDiagnosis.belongsTo(User, { as: 'addedBy',    foreignKey: 'addedById'    })
 *   PatientDiagnosis.belongsTo(User, { as: 'resolvedBy', foreignKey: 'resolvedById' })
 */
const PatientDiagnosis = defineModel('PatientDiagnosis', {
  diagnosis: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // Optional catalog code (e.g. ICD) — mirrors the {code, description} shape
  // used by DiagnosisInput / treatment plans.
  code: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('active', 'resolved'),
    allowNull: false,
    defaultValue: 'active',
  },
  diagnosedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  resolvedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = PatientDiagnosis;
