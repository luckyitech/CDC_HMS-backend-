const { defineModel, DataTypes } = require('../utils/defineModel');

// Staff-scoped documents — practising licences, qualification certificates,
// training records, HR files. The staff equivalent of MedicalDocument, and it
// deliberately mirrors that model's file-storage fields (fileName / filePath /
// fileSize / fileUrl) so both reuse middleware/upload and the same on-disk
// /uploads pipeline.
//
// Two links to User, both explicit camelCase foreign keys (association-generated
// PascalCase keys are avoided here because there are two of them and they must
// not collide):
//   staffUserId  — whose file this document belongs to
//   uploadedById — the admin who uploaded it
// Both are wired in models/index.js.
const StaffDocument = defineModel('StaffDocument', {
  documentId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  documentCategory: {
    type: DataTypes.STRING,   // Practising Licence, Qualification, Training, ID, HR, Other
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
    type: DataTypes.STRING,   // internal path: /uploads/documents/<uuid.ext>
  },
  // Optional expiry — practising licences and certifications lapse. NULL means
  // "no expiry" (e.g. a degree certificate). The frontend flags a document
  // amber as it approaches this date.
  expiryDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  notes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Soft delete. Clinical/HR records are never hard-deleted (see the codebase
  // convention that new tables soft-delete via a status field). 'archived'
  // hides a document from every view without removing the file or row.
  status: {
    type: DataTypes.ENUM('active', 'archived'),
    allowNull: false,
    defaultValue: 'active',
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
    { unique: true, fields: ['documentId'], name: 'unique_staff_documentId' },
  ],
});

module.exports = StaffDocument;
