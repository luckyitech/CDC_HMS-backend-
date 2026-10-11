const { defineModel, DataTypes } = require('../utils/defineModel');

// The trail for histology / cytology (H5): every correction of a typed result
// (what changed as { field: [before, after] } JSON TEXT, why, who, when) and
// every cancellation. Never edited or deleted.
const HistologyEdit = defineModel('HistologyEdit', {
  // HistologyRequestId — HistologyRequest.hasMany(HistologyEdit, { as: 'edits' })
  action:     { type: DataTypes.ENUM('amend_result', 'cancel'), allowNull: false },
  changes:    { type: DataTypes.TEXT, allowNull: false },
  reason:     { type: DataTypes.STRING(500), allowNull: false },
  editedById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  updatedAt: false,
  indexes: [{ name: 'idx_histology_edit_request', fields: ['HistologyRequestId'] }],
});

module.exports = HistologyEdit;
