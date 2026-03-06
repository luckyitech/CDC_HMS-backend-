const { defineModel, DataTypes } = require('../utils/defineModel');

const Appointment = defineModel('Appointment', {
  // patientId — added by Patient.hasMany(Appointment)
  // doctorId  — added by Appointment.belongsTo(User, { as: 'doctor' })

  appointmentNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  timeSlot: {
    type: DataTypes.STRING,   // "9:00 AM"
    allowNull: false,
  },
  appointmentType: {
    type: DataTypes.STRING,   // follow-up, routine check-up, urgent
  },
  reason: {
    type: DataTypes.TEXT,
  },
  notes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  duration: {
    type: DataTypes.STRING,   // "30 minutes"
    defaultValue: null,
  },
  specialty: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('scheduled', 'checked-in', 'completed', 'cancelled'),
    allowNull: false,
    defaultValue: 'scheduled',   // all lowercase — matches frontend
  },
  bookedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  indexes: [
    { unique: true, fields: ['appointmentNumber'], name: 'unique_appointmentNumber' },
  ],
});

module.exports = Appointment;
