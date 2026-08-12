const { defineModel, DataTypes } = require('../utils/defineModel');

// HR documents attached to a member of staff.
//
// Deliberately a separate table from MedicalDocument, and a separate directory
// on disk. Staff HR files in the patient document store would surface in
// patient document listings and inherit patient access rules — wrong on both
// counts. The shape mirrors MedicalDocument so the two behave alike.
//
// UserId and uploadedById are added by the associations in index.js.
const StaffDocument = defineModel('StaffDocument', {
  documentId: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  category: {
    type: DataTypes.ENUM(
      'Employment Contract', 'National ID', 'Practising Licence',
      'Academic Certificate', 'CV', 'Training Certificate',
      'Sick Note', 'Appraisal', 'Disciplinary', 'Other'
    ),
    allowNull: false,
    defaultValue: 'Other',
  },

  // Who may see it. A contract, an appraisal and a disciplinary letter are not
  // the same as a CV, so one flat list visible to the staff member would be
  // wrong. Defaults to the restrictive option: a document nobody classified
  // stays admin-only rather than leaking.
  visibility: {
    type: DataTypes.ENUM('Staff', 'Admin only'),
    allowNull: false,
    defaultValue: 'Admin only',
  },

  fileName: {
    type: DataTypes.STRING,
    allowNull: false,       // original file name, as uploaded
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: false,       // server-side stored path
  },
  fileSize: {
    type: DataTypes.STRING, // "320 KB"
  },
  fileUrl: {
    type: DataTypes.STRING, // /uploads/staff-documents/<uuid.ext>
  },
  uploadedByRole: {
    type: DataTypes.STRING,
  },

  // Optional expiry. A practising licence, an indemnity certificate and a BLS
  // card all lapse on different dates, which a single licenceExpiry on the
  // profile cannot express — so expiry belongs on the document, not the person.
  // NULL means "does not expire" (a degree certificate).
  expiryDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },

  notes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  // Archive rather than delete, matching MedicalDocument: a wrongly uploaded
  // file is hidden everywhere but never destroyed.
  isArchived: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  archivedById: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  archivedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Why it was archived — the useful half. "Superseded by the 2027 licence"
  // and "uploaded to the wrong person" need different follow-up.
  archiveReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
}, {
  indexes: [
    { unique: true, fields: ['documentId'], name: 'unique_staff_document_id' },
  ],
});

module.exports = StaffDocument;
