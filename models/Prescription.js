const { defineModel, DataTypes } = require('../utils/defineModel');

const Prescription = defineModel('Prescription', {
  // patientId — added by Patient.hasMany(Prescription)
  // doctorId  — added by Prescription.belongsTo(User, { as: 'doctor' })

  prescriptionNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  date: {
    type: DataTypes.DATEONLY,
    defaultValue: DataTypes.NOW,
  },
  diagnosis: {
    type: DataTypes.STRING,
  },
  status: {
    type: DataTypes.ENUM('Active', 'Completed', 'Cancelled'),
    allowNull: false,
    defaultValue: 'Active',
  },
  // Each item: { name, genericName, dosage, frequency, duration, quantity, instructions, refills }
  medications: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  notes: {
    type: DataTypes.TEXT,
  },
  // The remote request (phone / WhatsApp / email / walk-in without a visit)
  // this prescription answered — NULL when written in a consultation.
  // Migration 20260928000020.
  remoteRequestId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  indexes: [
    { unique: true, fields: ['prescriptionNumber'], name: 'unique_prescriptionNumber' },
  ],
});

module.exports = Prescription;
