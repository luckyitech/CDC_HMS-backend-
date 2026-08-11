const { defineModel, DataTypes } = require('../utils/defineModel');

// One row per scheduled/actual drug administration — the nurse's signature.
// The due-list is generated on demand; only real events are stored here
// (sparse table, upsert on sign). Never hard-deleted.
const MedicationAdministration = defineModel('MedicationAdministration', {
  // InpatientMedicationOrderId, AdmissionId, PatientId — association-generated
  scheduledDate: { type: DataTypes.DATEONLY, allowNull: false },
  roundLabel:    { type: DataTypes.STRING,  allowNull: true },  // which round time e.g. '06:00' (null for PRN/stat)
  scheduledTime: { type: DataTypes.DATE,    allowNull: true },
  status: {
    type: DataTypes.ENUM('Given', 'Held', 'Refused', 'Omitted', 'NotAvailable', 'Due'),
    allowNull: false,
    defaultValue: 'Due',
  },
  administeredAt:   { type: DataTypes.DATE,    allowNull: true },
  administeredById: { type: DataTypes.INTEGER, allowNull: true },  // nurse, JWT — the signature
  witnessedById:    { type: DataTypes.INTEGER, allowNull: true },  // controlled drugs
  reasonIfNotGiven: { type: DataTypes.STRING,  allowNull: true },
  notes:            { type: DataTypes.TEXT,    allowNull: true },
});

module.exports = MedicationAdministration;
