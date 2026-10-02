const { defineModel, DataTypes } = require('../utils/defineModel');

// A position (job title) on the clinic's managed list (HR Tier 3 Phase 1;
// migration 20260928000011). `cadre` only sorts the picker — it never limits
// who may hold the position (a nurse may hold role 'staff'). Never deleted:
// archived. The name is copied onto StaffProfile.position as the display copy,
// written only by services/staffLists.
const Position = defineModel('Position', {
  name: { type: DataTypes.STRING(120), allowNull: false },
  cadre: { type: DataTypes.ENUM('doctor', 'nurse', 'lab', 'staff'), allowNull: true },
  status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  indexes: [{ unique: true, fields: ['name'], name: 'uniq_position_name' }],
});

module.exports = Position;
