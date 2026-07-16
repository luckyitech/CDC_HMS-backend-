const { defineModel, DataTypes } = require('../utils/defineModel');

const MedicalDocument = defineModel('MedicalDocument', {
  // patientId    — added by Patient.hasMany(MedicalDocument)
  // uploadedById — added by MedicalDocument.belongsTo(User, { as: 'uploader' })

  documentId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  uploadedByRole: {
    type: DataTypes.STRING,   // 'Doctor' or 'Patient'
  },
  documentCategory: {
    type: DataTypes.STRING,   // Lab Report - External, Imaging Report, etc.
  },
  testType: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  labName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,         // original file name
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: false,         // server-side stored path
  },
  fileSize: {
    type: DataTypes.STRING,   // "320 KB"
  },
  fileUrl: {
    type: DataTypes.STRING,   // public path: /uploads/documents/<uuid.ext>
  },
  testDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('Pending Review', 'Reviewed', 'Archived'),
    allowNull: false,
    defaultValue: 'Pending Review',   // controller overrides based on uploader role
  },
  reviewedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  reviewDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  notes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Admin archive ("recycle bin") — hides wrongly uploaded documents from
  // every view without ever deleting them. Distinct from status 'Archived',
  // which only hides a document from the patient portal.
  isArchived: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  archivedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  archivedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  archiveReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
}, {
  indexes: [
    { unique: true, fields: ['documentId'], name: 'unique_documentId' },
  ],
});

module.exports = MedicalDocument;
