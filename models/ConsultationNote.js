const { defineModel, DataTypes } = require('../utils/defineModel');

const ConsultationNote = defineModel('ConsultationNote', {
  // patientId — added by Patient.hasMany(ConsultationNote)
  // doctorId  — added by ConsultationNote.belongsTo(User, { as: 'doctor' })

  date: {
    type: DataTypes.DATEONLY,
  },
  time: {
    type: DataTypes.STRING,   // "10:30 AM"
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  // Snapshot of the patient's vitals at consultation time
  vitals: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  assessment: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  plan: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // IDs of prescriptions written during this consultation
  prescriptionIds: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
});

module.exports = ConsultationNote;
