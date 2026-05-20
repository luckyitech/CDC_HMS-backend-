const { defineModel, DataTypes } = require('../utils/defineModel');

// A doctor can block individual time slots or an entire day.
// timeSlot = 'ALL_DAY' means the whole date is blocked.
// timeSlot = '9:00 AM' etc. means only that slot is blocked.
const DoctorBlock = defineModel('DoctorBlock', {
  doctorId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  timeSlot: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  blockedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  reason: {
    type: DataTypes.TEXT,
    defaultValue: null,   // internal — visible to doctor (own) + admin only
  },
}, {
  indexes: [
    {
      unique: true,
      fields: ['doctorId', 'date', 'timeSlot'],
      name: 'unique_doctor_date_slot_block',
    },
  ],
});

module.exports = DoctorBlock;
