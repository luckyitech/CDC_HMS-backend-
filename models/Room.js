const { defineModel, DataTypes } = require('../utils/defineModel');

// A room within a ward. Holds one or more beds (uniform per-bed model:
// a single-bed private room is just a room with one bed).
const Room = defineModel('Room', {
  // WardId — association-generated
  name:        { type: DataTypes.STRING,  allowNull: false },   // room number / name
  type:        {
    type: DataTypes.ENUM('General', 'HDU', 'Private', 'Isolation'),
    allowNull: false,
    defaultValue: 'General',
  },
  bedCapacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  isActive:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
});

module.exports = Room;
