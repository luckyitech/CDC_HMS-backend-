const { defineModel, DataTypes } = require('../utils/defineModel');

const EquipmentHistory = defineModel('EquipmentHistory', {
  // patientId   — added by Patient.hasMany(EquipmentHistory)
  // equipmentId — added by MedicalEquipment.hasMany(EquipmentHistory)

  deviceType: {
    type: DataTypes.ENUM('pump', 'transmitter'),
    allowNull: false,
  },
  type: {
    type: DataTypes.STRING,   // new / upgrade / replacement
    defaultValue: null,
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
  // CareLink account snapshot — pump only
  careLinkCountry: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  careLinkEmail: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  careLinkPassword: {
    type: DataTypes.STRING,   // stored AES-256 encrypted
    defaultValue: null,
  },

  addedBy: {
    type: DataTypes.INTEGER,   // User ID who originally added this device
    defaultValue: null,
  },
  addedDate: {
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
