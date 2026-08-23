const { defineModel, DataTypes } = require('../utils/defineModel');

const LabTest = defineModel('LabTest', {
  // patientId   — added by Patient.hasMany(LabTest)
  // orderedById — added by LabTest.belongsTo(User, { as: 'orderedBy' })

  testNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  testType: {
    type: DataTypes.STRING,
    allowNull: false,  // HbA1c, Lipid Profile, Fasting Blood Sugar, etc.
  },
  sampleType: {
    type: DataTypes.STRING,   // Blood, Urine, etc.
  },
  priority: {
    type: DataTypes.ENUM('Routine', 'Urgent', 'STAT'),
    defaultValue: 'Routine',
  },
  status: {
    // 'Cancelled' is a soft-cancel — a request the clinician withdrew before the
    // lab acted on it, or the losing side of a cancel-&-reissue. The row stays
    // in the record; it is never hard-deleted.
    type: DataTypes.ENUM('Pending', 'Sample Collected', 'In Progress', 'Completed', 'Cancelled'),
    allowNull: false,
    defaultValue: 'Pending',
  },

  // ── Request-form fields ────────────────────────────────────────────────────
  // Free-text special instructions for the lab (fasting, handling, etc.). Prints
  // on the requisition. Was collected by the old modal and silently dropped —
  // there was no column for it.
  notes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // REQ-YYYY-NNN — shared by every test submitted together, so a multi-test
  // request groups into one card and one printable requisition.
  requisitionNumber: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // KES price snapshot at order time (from the catalogue) — survives later
  // catalogue price changes.
  price: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: null,
  },
  // onBehalfOfDoctorId — added by LabTest.belongsTo(User, { as: 'onBehalfOfDoctor' }).
  // The doctor a nurse-raised request is for; null for doctor-raised requests.

  // Package snapshots — set when the test came from a bundle. packageRate is the
  // package's special rate (null when the package is priced as the sum of its
  // tests); the per-row `price` still carries the test's own price.
  packageName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  packageRate: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: null,
  },
  // The requisition this one replaces (cancel & reissue). The superseded
  // requisition's rows are set to 'Cancelled'.
  supersedesRequisition: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Who cancelled this test and when (set when status → 'Cancelled'), mirroring
  // the Appointment cancellation columns so the activity log can attribute it.
  cancelledBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  cancelledByRole: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  cancelledAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  orderedDate: {
    type: DataTypes.DATEONLY,
  },
  orderedTime: {
    type: DataTypes.STRING,   // "10:30 AM"
  },
  sampleCollected: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  collectionDate: {
    type: DataTypes.STRING,   // "2025-01-10 11:00 AM"
    defaultValue: null,
  },

  // Flexible JSON — different fields depending on testType
  results: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  normalRange: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  interpretation: {
    type: DataTypes.STRING,   // Normal, Abnormal, Critical
    defaultValue: null,
  },
  isCritical: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  technicianNotes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  completedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  completedDate: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  reportGenerated: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  indexes: [
    { unique: true, fields: ['testNumber'], name: 'unique_testNumber' },
  ],
});

module.exports = LabTest;
