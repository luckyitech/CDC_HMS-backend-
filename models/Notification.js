const { defineModel, DataTypes } = require('../utils/defineModel');

const Notification = defineModel('Notification', {
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'document_uploaded',
  },
  patientName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  patientUhid: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  documentName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  documentCategory: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  uploadedBy: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  // assignedDoctorId — added via Notification.belongsTo(User) in models/index.js
  isRead: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
});

module.exports = Notification;
