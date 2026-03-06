const { defineModel, DataTypes } = require('../utils/defineModel');

const TreatmentPlan = defineModel('TreatmentPlan', {
  // patientId — added by Patient.hasMany(TreatmentPlan)
  // doctorId  — added by TreatmentPlan.belongsTo(User, { as: 'doctor' })

  date: {
    type: DataTypes.DATEONLY,
  },
  time: {
    type: DataTypes.STRING,   // "10:30 AM"
  },
  diagnosis: {
    type: DataTypes.STRING,
  },
  plan: {
    type: DataTypes.TEXT,     // multi-line detailed plan
  },
  status: {
    type: DataTypes.ENUM('Active', 'Completed'),
    allowNull: false,
    defaultValue: 'Active',
  },
  consultationId: {
    type: DataTypes.INTEGER,  // optional reference to a related consultation
    defaultValue: null,
  },
});

module.exports = TreatmentPlan;
