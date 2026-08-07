const { defineModel, DataTypes } = require('../utils/defineModel');

// A single bed. Its `status` is the source of truth for the ward board and is
// only ever mutated by the admission / transfer / discharge controllers (and
// the porter turnaround action). Admin CRUD may set Available/Blocked for
// maintenance but must NEVER set Occupied directly.
const Bed = defineModel('Bed', {
  // RoomId, WardId — association-generated (WardId denormalised for board reads)
  label:  { type: DataTypes.STRING, allowNull: false },        // e.g. "3B"
  status: {
    type: DataTypes.ENUM('Available', 'Occupied', 'Cleaning', 'Blocked', 'Reserved'),
    allowNull: false,
    defaultValue: 'Available',
  },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
});

module.exports = Bed;
