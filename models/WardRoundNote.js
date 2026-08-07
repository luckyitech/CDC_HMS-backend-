const { defineModel, DataTypes } = require('../utils/defineModel');

// Daily inpatient progress note (SOAP), doctor-authored. Distinct from the OPD
// ConsultationNote. Soft-delete + amendment audit trail (never destroy()).
const WardRoundNote = defineModel('WardRoundNote', {
  // AdmissionId, PatientId — association-generated (PatientId denormalised)
  doctorId:      { type: DataTypes.INTEGER, allowNull: true },   // author, JWT
  roundDateTime: { type: DataTypes.DATE,    allowNull: false },
  subjective:    { type: DataTypes.TEXT,    allowNull: true },
  objective:     { type: DataTypes.TEXT,    allowNull: true },
  assessment:    { type: DataTypes.TEXT,    allowNull: true },
  plan:          { type: DataTypes.TEXT,    allowNull: true },
  reviewFlag:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

  status:      { type: DataTypes.ENUM('active', 'amended', 'voided'), allowNull: false, defaultValue: 'active' },
  amendedById: { type: DataTypes.INTEGER, allowNull: true },
  amendedAt:   { type: DataTypes.DATE,    allowNull: true },
});

module.exports = WardRoundNote;
