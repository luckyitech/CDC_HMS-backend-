const { defineModel, DataTypes } = require('../utils/defineModel');

// A doctor's inpatient medication order for an admission (distinct from the
// take-home Prescription). Schedule comes from the SHARED drugSchedules source
// (scheduleCode) with the resolved round times frozen at order time
// (scheduleTimes) so later edits to the shared list never move existing orders.
const InpatientMedicationOrder = defineModel('InpatientMedicationOrder', {
  // AdmissionId, PatientId — association-generated (PatientId denormalised)
  catalogItemId: { type: DataTypes.INTEGER, allowNull: true },   // FK to CatalogItem (medication) where possible
  drugName:      { type: DataTypes.STRING,  allowNull: false },  // fallback / free-text
  dose:          { type: DataTypes.STRING,  allowNull: false },  // '500 mg'
  route: {
    type: DataTypes.ENUM('PO', 'IV', 'IM', 'SC', 'PR', 'INH', 'TOP', 'Other'),
    allowNull: false,
    defaultValue: 'PO',
  },
  scheduleCode:  { type: DataTypes.STRING, allowNull: true },   // from shared DRUG_SCHEDULES, e.g. 'BD'
  scheduleTimes: { type: DataTypes.JSON,   allowNull: true },   // frozen round times e.g. ['06:00','22:00']
  frequencyLabel:{ type: DataTypes.STRING, allowNull: true },   // human label e.g. 'Twice daily'
  isPRN:         { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  prnIndication: { type: DataTypes.STRING,  allowNull: true },
  isStat:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, // one-off
  statTime:      { type: DataTypes.DATE,    allowNull: true },
  startDateTime: { type: DataTypes.DATE,    allowNull: false },
  stopDateTime:  { type: DataTypes.DATE,    allowNull: true },
  prescribedById:{ type: DataTypes.INTEGER, allowNull: true },  // doctor, JWT
  status: {
    type: DataTypes.ENUM('Active', 'Suspended', 'Stopped', 'Completed'),
    allowNull: false,
    defaultValue: 'Active',
  },
  stoppedById: { type: DataTypes.INTEGER, allowNull: true },
  stopReason:  { type: DataTypes.STRING,  allowNull: true },
});

module.exports = InpatientMedicationOrder;
