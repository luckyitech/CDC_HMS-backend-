const { defineModel, DataTypes } = require('../utils/defineModel');

// The append-only stock ledger — the source of truth. Rows are never updated
// or deleted; mistakes are corrected with a 'reversal' row, like an
// accounting ledger. StockLevel is a materialized convenience rebuilt from
// this table on demand.
const StockMovement = defineModel('StockMovement', {
  // 'intake' | 'dispense' | 'use' | 'transfer' | 'adjustment' |
  // 'expiry_writeoff' | 'damage_writeoff' | 'return' | 'reversal'
  // ('use' = point-of-care consumption from a room; 'dispense' = item leaves
  // with the patient.) STRING so new types need no migration.
  type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // stockItemId (denormalised from batch), stockBatchId, fromLocationId,
  // toLocationId, prescriptionId, performedById, reversesMovementId — aliased
  // associations in models/index.js.
  // PatientId — association-generated PascalCase FK (Patient.hasMany), nullable
  // until the patient-linking phase activates.

  // Always positive — direction comes from type + locations, not sign.
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 1 },
  },
  // Required by the controller for adjustment, write-offs, reversal and FEFO
  // overrides. TEXT (not STRING) to match every other reason/note column in
  // the codebase — free-text overrides and the concatenated stocktake string
  // ("Stocktake: <note> (expected 12, counted 10)") can exceed 255 chars, and
  // MySQL 8's strict mode errors on overflow rather than truncating.
  reason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
}, {
  indexes: [
    { fields: ['stockItemId', 'createdAt'], name: 'idx_stock_movements_item_created' },
    { fields: ['stockBatchId'],             name: 'idx_stock_movements_batch' },
    { fields: ['type', 'createdAt'],        name: 'idx_stock_movements_type_created' },
  ],
});

module.exports = StockMovement;
