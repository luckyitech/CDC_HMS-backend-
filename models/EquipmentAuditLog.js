const { defineModel, DataTypes } = require('../utils/defineModel');

const EquipmentAuditLog = defineModel('EquipmentAuditLog', {
  // PatientId   — added by Patient.hasMany(EquipmentAuditLog)
  // equipmentId — FK to MedicalEquipment (nullable: equipment may be replaced/archived)

  equipmentId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  action: {
    type: DataTypes.ENUM('add', 'edit', 'replace'),
    allowNull: false,
  },
  deviceType: {
    type: DataTypes.ENUM('pump', 'transmitter'),
    allowNull: false,
  },
  field: {
    type: DataTypes.STRING,   // null for add/replace actions
    defaultValue: null,
  },
  oldValue: {
    type: DataTypes.TEXT,     // null for add actions
    defaultValue: null,
  },
  newValue: {
    type: DataTypes.TEXT,     // null for replace actions (summary carries the detail)
    defaultValue: null,
  },
  summary: {
    type: DataTypes.TEXT,     // human-readable description for add/replace actions
    defaultValue: null,
  },
  changedBy: {
    type: DataTypes.INTEGER,  // User ID
    allowNull: false,
  },
  changedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

module.exports = EquipmentAuditLog;
