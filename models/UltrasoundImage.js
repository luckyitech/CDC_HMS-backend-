const { defineModel, DataTypes } = require('../utils/defineModel');

// HMIS V4 — Ultrasound images auto-ingested from the Samsung HS70A via the
// clinic-side DICOM bridge (bridge/). Distinct from MedicalDocument (manual
// uploads) and RadiologyOrder (inpatient order → report workflow): these rows
// arrive machine-pushed, keyed by the SOP Instance UID for idempotent ingest.
const UltrasoundImage = defineModel('UltrasoundImage', {
  // PatientId — association-generated (nullable: null ⇒ Unassigned queue)

  dicomPatientId: {
    type: DataTypes.STRING,
    allowNull: false,         // raw Patient ID typed on the HS70A (should be the UHID)
  },
  // Demographics as typed on the machine (DICOM header) — used by the
  // Ultrasound Studio worklist for sorting/grouping. NOT authoritative.
  patientName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  patientBirthDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  studyInstanceUid: {
    type: DataTypes.STRING,
    defaultValue: null,       // groups images into one study/exam
  },
  sopInstanceUid: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,             // DICOM-global unique id — dedupe key for retries
  },
  studyDate: {
    type: DataTypes.DATEONLY,
    defaultValue: null,
  },
  studyDescription: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  isMultiframe: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,      // true ⇒ PNG is the middle frame of a cine clip
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,         // display name, e.g. US_20260808_103000.png
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: false,         // server-side stored path
  },
  fileUrl: {
    type: DataTypes.STRING,   // /uploads/ultrasound/<uuid>.png (served authenticated)
  },
  status: {
    type: DataTypes.ENUM('Unassigned', 'Matched', 'Archived'),
    allowNull: false,
    defaultValue: 'Unassigned',
  },
  // Machine-inbox listing: stays true (listed) until a user explicitly
  // removes the study from the inbox. Attaching/saving does not clear it.
  inInbox: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  // Admin archive — mirrors MedicalDocument: soft-hide, never delete.
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
  receivedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,   // when the bridge received it from the machine
  },
});

module.exports = UltrasoundImage;
