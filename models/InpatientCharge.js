const { defineModel, DataTypes } = require('../utils/defineModel');

// Inpatient billing line item. Charges accrue over the stay (bed-days at
// per-midnight-crossed, drugs, procedures, labs, radiology) and are tallied at
// discharge. sourceType/sourceId trace a charge back to what generated it.
const InpatientCharge = defineModel('InpatientCharge', {
  // AdmissionId, PatientId — association-generated
  chargeDate:  { type: DataTypes.DATEONLY, allowNull: false },
  category: {
    type: DataTypes.ENUM('BedDay', 'Drug', 'Procedure', 'Lab', 'Radiology', 'Consumable', 'Other'),
    allowNull: false,
    defaultValue: 'Other',
  },
  description: { type: DataTypes.STRING,  allowNull: false },
  quantity:    { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  unitAmount:  { type: DataTypes.FLOAT,   allowNull: false, defaultValue: 0 },
  amount:      { type: DataTypes.FLOAT,   allowNull: false, defaultValue: 0 },
  sourceType:  { type: DataTypes.STRING,  allowNull: true },   // 'BedAssignment' | 'MedicationAdministration' | ...
  sourceId:    { type: DataTypes.INTEGER, allowNull: true },
  addedById:   { type: DataTypes.INTEGER, allowNull: true },
  status:      { type: DataTypes.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
});

module.exports = InpatientCharge;
