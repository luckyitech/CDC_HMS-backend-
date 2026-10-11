const { defineModel, DataTypes } = require('../utils/defineModel');

// Which findings a procedure treated (H8) — one row per finding.
const DermProcedureTarget = defineModel('DermProcedureTarget', {
  // DermProcedureId — DermProcedure.hasMany(DermProcedureTarget, { as: 'targets' })
  // DermFindingId   — DermProcedureTarget.belongsTo(DermFinding)
}, {
  timestamps: false,
  indexes: [{ unique: true, fields: ['DermProcedureId', 'DermFindingId'], name: 'unique_derm_procedure_target' }],
});

module.exports = DermProcedureTarget;
