const { defineModel, DataTypes } = require('../utils/defineModel');

const EquipmentHistory = defineModel('EquipmentHistory', {
  // patientId   — added by Patient.hasMany(EquipmentHistory)
  // equipmentId — added by MedicalEquipment.hasMany(EquipmentHistory)

  deviceType: {
    type: DataTypes.ENUM('pump', 'transmitter'),
    allowNull: false,
  },
  serialNo: {
    type: DataTypes.STRING,
  },
  model: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  manufacturer: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  startDate: {
    type: DataTypes.DATE,
  },
  warrantyStartDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  warrantyEndDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  endDate: {
    type: DataTypes.DATE,     // when this equipment was replaced
  },
  reason: {
    type: DataTypes.TEXT,     // why it was replaced
  },
  archivedBy: {
    type: DataTypes.INTEGER,   // User ID who replaced/archived it
  },
  archivedDate: {
    type: DataTypes.DATE,
  },
});

module.exports = EquipmentHistory;
