const { defineModel, DataTypes } = require('../utils/defineModel');

const Queue = defineModel('Queue', {
  // patientId       — added by Patient.hasMany(Queue)
  // assignedDoctorId — added by Queue.belongsTo(User, { as: 'assignedDoctor' }) — nullable

  status: {
    type: DataTypes.ENUM('Waiting', 'In Triage', 'With Doctor', 'Pending Billing', 'Completed'),
    allowNull: false,
    defaultValue: 'Waiting',
  },
  priority: {
    type: DataTypes.ENUM('Normal', 'Urgent'),
    allowNull: false,
    defaultValue: 'Normal',
  },
  reason: {
    type: DataTypes.TEXT,
  },

  // Set by the controller when consultation starts / ends
  consultationStartTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  consultationEndTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // Set by doctor when completing consultation — stored as JSON arrays of strings
  selectedCharges: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  selectedProcedures: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
});

module.exports = Queue;
