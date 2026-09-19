const db = require('../models');
const { broadcast } = require('./sseManager');

const { MedicalDocument, Patient, User, Notification } = db;

// ---------------------------------------------------------------------------
// Shared MedicalDocument creation.
//
// The one place a MedicalDocument record is born, plus the doctor notification
// + SSE broadcast that go with it. Both the manual upload (documentController)
// and the Lab Inbox pairing (labInboxController) call this, so the two paths
// can never drift — a report paired from the inbox lands in Diagnostics exactly
// as a hand-uploaded one does.
//
// The FILE is expected to already be in its final place under
// uploads/documents/ (the caller stages/copies it and passes the details).
// This function does no disk I/O — it only writes the record and notifies.
//
// Merge-awareness and deactivation refusal are the CALLER's job (they hold the
// resolved patient family); this takes the already-resolved canonical patient.
// ---------------------------------------------------------------------------

const formatFileSize = (bytes) => {
  if (bytes == null) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/**
 * @param {object}  opts
 * @param {object}  opts.patient        canonical Patient instance (family.patient)
 * @param {object}  opts.actingUser     req.user (JWT) — attribution source
 * @param {object}  opts.file           { originalName, filename, size }  (already in uploads/documents/)
 * @param {string}  opts.documentCategory
 * @param {string} [opts.testType]
 * @param {string} [opts.labName]
 * @param {string} [opts.testDate]      YYYY-MM-DD
 * @param {string} [opts.notes]
 * @param {string} [opts.status]        defaults by role: doctor -> Reviewed, else Pending Review
 * @returns {Promise<MedicalDocument>}  full record with Patient + uploader included
 */
const createMedicalDocument = async ({
  patient, actingUser, file, documentCategory,
  testType = null, labName = null, testDate = null, notes = null, status,
}) => {
  const role = (actingUser.role || '').toLowerCase();
  const finalStatus = status || (role === 'doctor' ? 'Reviewed' : 'Pending Review');

  const document = await MedicalDocument.create({
    documentId: `DOC-${Date.now()}`,
    PatientId: patient.id,
    uploadedById: actingUser.id,
    uploadedByRole: role ? role.charAt(0).toUpperCase() + role.slice(1) : null,
    documentCategory,
    testType,
    labName,
    fileName: file.originalName,
    filePath: `uploads/documents/${file.filename}`,
    fileSize: formatFileSize(file.size),
    fileUrl: `/uploads/documents/${file.filename}`,
    testDate,
    status: finalStatus,
    notes,
  });

  const fullDocument = await MedicalDocument.findByPk(document.id, {
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'uploader', attributes: ['firstName', 'lastName'] },
    ],
  });

  // Notify the assigned doctor. Isolated — a notification failure must never
  // fail a successful document creation (same rule as documentController).
  if (role !== 'patient') {
    try {
      const patientName = `${patient.firstName} ${patient.lastName}`;
      const uploaderName =
        `${actingUser.firstName || ''} ${actingUser.lastName || ''}`.trim() ||
        actingUser.name || 'Staff';

      const notification = await Notification.create({
        type: 'document_uploaded',
        patientName,
        patientUhid: patient.uhid,
        documentName: file.originalName,
        documentCategory,
        uploadedBy: uploaderName,
        assignedDoctorId: patient.primaryDoctorId || null,
        isRead: false,
      });

      broadcast('document_uploaded', {
        id: notification.id,
        type: 'document_uploaded',
        patientName,
        patientUhid: patient.uhid,
        documentName: file.originalName,
        documentCategory,
        uploadedBy: uploaderName,
        assignedDoctorId: patient.primaryDoctorId || null,
        createdAt: notification.createdAt,
      });
    } catch (notifErr) {
      console.error('Notification create error (non-fatal):', notifErr.message);
    }
  }

  return fullDocument;
};

module.exports = { createMedicalDocument, formatFileSize };
