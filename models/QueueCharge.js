const { defineModel, DataTypes } = require('../utils/defineModel');

// One line on a visit's bill, with WHO put it there and at which STAGE
// (12 Oct 2026, Emu): "the bill for each patient should be carried through all
// the stages" — nurse, doctor, cashier all see the same lines and who added
// each. Queue.selectedCharges / selectedProcedures stay the bill itself (every
// existing reader keeps working); this is its attribution and history, written
// only through utils/visitCharges. Removal is soft (status 'removed' + who/why).
const QueueCharge = defineModel('QueueCharge', {
  // QueueId — association in models/index.js; addedById / removedById aliased
  kind: {
    type: DataTypes.STRING(20),          // 'charge' | 'procedure'
    allowNull: false,
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
  },
  stage: {
    type: DataTypes.STRING(20),          // 'triage' | 'consultation' | 'injection' | 'radiology' | 'billing' | 'other'
    allowNull: false,
  },
  source: {
    type: DataTypes.STRING(20),          // 'picked' | 'vital' (added by entering a triage result)
    allowNull: false,
    defaultValue: 'picked',
  },
  addedByName: { type: DataTypes.STRING(120), defaultValue: null },
  addedByRole: { type: DataTypes.STRING(20), defaultValue: null },
  status: {
    type: DataTypes.STRING(20),          // 'active' | 'removed'
    allowNull: false,
    defaultValue: 'active',
  },
  removedByName: { type: DataTypes.STRING(120), defaultValue: null },
  removedAt: { type: DataTypes.DATE, defaultValue: null },
  removedReason: { type: DataTypes.STRING(255), defaultValue: null },
}, {
  indexes: [{ fields: ['QueueId', 'status'], name: 'idx_queue_charges_visit' }],
});

module.exports = QueueCharge;
