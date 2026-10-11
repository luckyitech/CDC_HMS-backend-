const { defineModel, DataTypes } = require('../utils/defineModel');

// A procedure done on one or more skin findings (Dermatology Phase 3,
// migration 20260928000023; decision H8). Recorded, not billed. `name` is
// from the clinic's list at the time (utils/dermProcedures) and is kept as
// saved. performedById comes from the login. HistologyRequestId links a
// biopsy recorded together with its histology request (H9).
// Never hard-deleted: entered_in_error with a reason. Amendments → DermEdits
// (entity 'procedure').
const DermProcedure = defineModel('DermProcedure', {
  // PatientId — Patient.hasMany(DermProcedure)
  procedureDate:      { type: DataTypes.DATEONLY, allowNull: false },
  name:               { type: DataTypes.STRING(120), allowNull: false },
  details:            { type: DataTypes.TEXT, allowNull: true },
  performedById:      { type: DataTypes.INTEGER, allowNull: true },
  HistologyRequestId: { type: DataTypes.INTEGER, allowNull: true },
  status:             { type: DataTypes.ENUM('active', 'entered_in_error'), allowNull: false, defaultValue: 'active' },
  errorReason:        { type: DataTypes.STRING(500), allowNull: true },
  errorById:          { type: DataTypes.INTEGER, allowNull: true },
  errorAt:            { type: DataTypes.DATE, allowNull: true },
  amendedById:        { type: DataTypes.INTEGER, allowNull: true },
  amendedAt:          { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [{ name: 'idx_derm_procedure_patient', fields: ['PatientId', 'procedureDate'] }],
});

module.exports = DermProcedure;
