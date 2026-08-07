const { defineModel, DataTypes } = require('../utils/defineModel');

// Bed-movement history for an admission. One row per physical location the
// patient occupied. The row with toDateTime = null is the current location
// (kept consistent with Admission.BedId in the same transaction).
const BedAssignment = defineModel('BedAssignment', {
  // AdmissionId, BedId, WardId — association-generated
  fromDateTime: { type: DataTypes.DATE, allowNull: false },
  toDateTime:   { type: DataTypes.DATE, allowNull: true },   // null = current location
  reason:       { type: DataTypes.TEXT, allowNull: true },   // 'Admission' | 'Transfer: ...' | 'Discharge'
  movedById:    { type: DataTypes.INTEGER, allowNull: true },// JWT
});

module.exports = BedAssignment;
