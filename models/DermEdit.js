const { defineModel, DataTypes } = require('../utils/defineModel');

// The amendment trail for the skin record (D7, D8). One row per amendment of
// a finding or an observation, and per "entered in error": what changed
// ({ field: [before, after] } as JSON TEXT), why, who, when. Never edited or
// deleted — it is how an earlier day can always be read as it was written.
const DermEdit = defineModel('DermEdit', {
  entity:     { type: DataTypes.ENUM('finding', 'observation', 'procedure', 'skin_exam'), allowNull: false },
  entityId:   { type: DataTypes.INTEGER, allowNull: false },
  action:     { type: DataTypes.ENUM('amend', 'entered_in_error'), allowNull: false },
  changes:    { type: DataTypes.TEXT, allowNull: false },
  reason:     { type: DataTypes.STRING(500), allowNull: false },
  editedById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  updatedAt: false,
  indexes: [{ name: 'idx_derm_edit_entity', fields: ['entity', 'entityId'] }],
});

module.exports = DermEdit;
