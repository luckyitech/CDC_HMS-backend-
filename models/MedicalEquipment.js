const { defineModel, DataTypes } = require('../utils/defineModel');

const MedicalEquipment = defineModel('MedicalEquipment', {
  // patientId — added by Patient.hasMany(MedicalEquipment)

  deviceType: {
    type: DataTypes.ENUM('pump', 'transmitter'),
    allowNull: false,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,       // set to false when replaced
  },
  type: {
    type: DataTypes.STRING,   // e.g. "new"
  },
  serialNo: {
    type: DataTypes.STRING,
  },
  model: {
    type: DataTypes.STRING,   // pump only
    defaultValue: null,
  },
  manufacturer: {
    type: DataTypes.STRING,   // pump only
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
  addedBy: {
    type: DataTypes.INTEGER,   // Must match User PK type (SIGNED — Sequelize default)
  },
  addedDate: {
    type: DataTypes.DATE,
  },
  lastUpdatedBy: {
    type: DataTypes.INTEGER,   // Must match User PK type (SIGNED — Sequelize default)
    defaultValue: null,
  },
  lastUpdatedDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
});

module.exports = MedicalEquipment;
