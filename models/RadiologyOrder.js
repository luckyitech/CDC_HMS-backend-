const { defineModel, DataTypes } = require('../utils/defineModel');

// Inpatient imaging order → report (Lab-style slice; radiology is a new domain).
// Report image files attach via the existing MedicalDocument upload path.
const RadiologyOrder = defineModel('RadiologyOrder', {
  // AdmissionId, PatientId — association-generated
  modality: {
    type: DataTypes.ENUM('XRay', 'CT', 'MRI', 'Ultrasound', 'Mammogram', 'Other'),
    allowNull: false,
    defaultValue: 'XRay',
  },
  region:          { type: DataTypes.STRING, allowNull: false },   // 'Chest', 'Abdomen', ...
  clinicalDetails: { type: DataTypes.TEXT,   allowNull: true },
  priority:        { type: DataTypes.ENUM('Routine', 'Urgent'), allowNull: false, defaultValue: 'Routine' },
  orderedById:     { type: DataTypes.INTEGER, allowNull: true },   // doctor, JWT
  status: {
    type: DataTypes.ENUM('Ordered', 'InProgress', 'Reported', 'Cancelled'),
    allowNull: false,
    defaultValue: 'Ordered',
  },
  reportText:      { type: DataTypes.TEXT,    allowNull: true },
  reportedById:    { type: DataTypes.INTEGER, allowNull: true },   // radiographer/radiologist, JWT
  reportedAt:      { type: DataTypes.DATE,    allowNull: true },
  documentId:      { type: DataTypes.INTEGER, allowNull: true },   // optional MedicalDocument (image)
});

module.exports = RadiologyOrder;
