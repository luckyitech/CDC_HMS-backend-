const { defineModel, DataTypes } = require('../utils/defineModel');

// The bell. Originally only "a document was uploaded for this patient"; since
// B27 (migration 20260928000004) also HR alerts, which have no patient:
//   category  'document' (the original kind) | 'hr' | …
//   title / body / link   what the bell shows, and the in-app path it opens.
// The patient fields are null on non-document rows. assignedDoctorId is the
// RECIPIENT (any user, not only a doctor) — the name is historical.
const Notification = defineModel('Notification', {
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'document_uploaded',
  },
  patientName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  patientUhid: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  documentName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  documentCategory: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  uploadedBy: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  category: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'document',
  },
  title: { type: DataTypes.STRING(255), allowNull: true },
  body:  { type: DataTypes.TEXT, allowNull: true },
  link:  { type: DataTypes.STRING(255), allowNull: true },
  // assignedDoctorId — the recipient; added via Notification.belongsTo(User) in models/index.js
  isRead: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
});

module.exports = Notification;
