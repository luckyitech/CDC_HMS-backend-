const { success, error } = require('../utils/response');
const db = require('../models');
const fs = require('fs');
const path = require('path');

const { MedicalDocument, Patient, User } = db;

// ====================================
// CONSTANTS
// ====================================

// Official document categories (from BACKEND_GUIDE.md)
const ALLOWED_CATEGORIES = [
  'Lab Report - External',
  'Imaging Report',
  'Cardiology Report',
  'Endocrinology Report',
  'Nephrology Report',
  'Ophthalmology Report',
  'Neuropathy Screening Test',
  'Specialist Consultation Report',
  'Patient File',
  'Other Medical Document'
];

// Categories that only accept PDF files
const PDF_ONLY_CATEGORIES = ['Patient File'];

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats file size from bytes to KB or MB
 */
const formatFileSize = (bytes) => {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/**
 * Formats document response
 */
const formatDocument = (doc) => {
  return {
    id: doc.id,
    documentId: doc.documentId,
    uhid: doc.Patient ? doc.Patient.uhid : null,
    patientName: doc.Patient ? `${doc.Patient.firstName} ${doc.Patient.lastName}` : null,
    uploadedBy: doc.uploader ? `${doc.uploader.firstName} ${doc.uploader.lastName}` : null,
    uploadedByRole: doc.uploadedByRole,
    documentCategory: doc.documentCategory,
    testType: doc.testType,
    labName: doc.labName,
    fileName: doc.fileName,
    fileSize: doc.fileSize,
    fileUrl: doc.fileUrl,
    testDate: doc.testDate,
    status: doc.status,
    reviewedBy: doc.reviewedBy,
    reviewDate: doc.reviewDate,
    notes: doc.notes,
    uploadedAt: doc.createdAt,
  };
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/documents
 * Upload a new document (multipart/form-data)
 *
 * Authorization: patient, doctor, staff
 */
const upload = async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return error(res, 'No file uploaded. Please select a file to upload.', 400);
    }

    const { uhid, documentCategory, testType, labName, testDate, notes } = req.body;

    // Validate file metadata
    if (req.file.originalname.length > 255) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Filename is too long. Maximum 255 characters allowed.', 400);
    }

    // Validate testDate format if provided
    if (testDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
        fs.unlinkSync(req.file.path);
        return error(res, 'Invalid testDate format. Use YYYY-MM-DD (e.g., 2026-02-10)', 400);
      }
      // Validate date is not in the future (compare as strings to avoid timezone issues)
      const todayStr = new Date().toISOString().split('T')[0];
      if (testDate > todayStr) {
        fs.unlinkSync(req.file.path);
        return error(res, 'Test date cannot be in the future.', 400);
      }
    }

    // Validate optional field lengths
    if (testType && testType.length > 255) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Test type is too long. Maximum 255 characters allowed.', 400);
    }
    if (labName && labName.length > 255) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Lab name is too long. Maximum 255 characters allowed.', 400);
    }
    if (notes && notes.length > 5000) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Notes are too long. Maximum 5000 characters allowed.', 400);
    }

    // Validate required fields
    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }
    if (!documentCategory) {
      return error(res, 'Document category is required', 400);
    }

    // Validate document category against allowed list
    if (!ALLOWED_CATEGORIES.includes(documentCategory)) {
      fs.unlinkSync(req.file.path);
      return error(res, `Invalid document category. Allowed categories: ${ALLOWED_CATEGORIES.join(', ')}`, 400);
    }

    // Enforce PDF-only for specific categories (e.g. Patient File)
    if (PDF_ONLY_CATEGORIES.includes(documentCategory) && req.file.mimetype !== 'application/pdf') {
      fs.unlinkSync(req.file.path);
      return error(res, `The "${documentCategory}" category only accepts PDF files.`, 400);
    }

    // Find patient
    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) {
      // Delete uploaded file if patient not found
      fs.unlinkSync(req.file.path);
      return error(res, `Patient with UHID '${uhid}' not found. Please verify the UHID and try again.`, 404);
    }

    // Generate document ID
    const documentId = `DOC-${Date.now()}`;

    // Format file size
    const fileSize = formatFileSize(req.file.size);

    // Create file URL (relative path for serving)
    const fileUrl = `/uploads/documents/${req.file.filename}`;

    // Determine status based on uploader role
    // Patient uploads → Pending Review
    // Doctor/Staff uploads → Reviewed
    const status = req.user.role === 'patient' ? 'Pending Review' : 'Reviewed';

    // Create document record
    const document = await MedicalDocument.create({
      documentId,
      PatientId: patient.id,
      uploadedById: req.user.id,
      uploadedByRole: req.user.role.charAt(0).toUpperCase() + req.user.role.slice(1),
      documentCategory,
      testType: testType || null,
      labName: labName || null,
      fileName: req.file.originalname,
      filePath: req.file.path,
      fileSize,
      fileUrl,
      testDate: testDate || null,
      status,
      notes: notes || null,
    });

    // Fetch full document with associations
    const fullDocument = await MedicalDocument.findByPk(document.id, {
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'uploader', attributes: ['firstName', 'lastName'] },
      ],
    });

    return success(res, formatDocument(fullDocument), 201);
  } catch (err) {
    // Clean up uploaded file on error
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Upload document error:', err.message);
    return error(res, 'Failed to upload document. Please try again.', 500);
  }
};

/**
 * GET /api/documents
 * List documents with filters
 *
 * Authorization: patient (own only), doctor, staff
 */
const list = async (req, res) => {
  try {
    const { uhid, category } = req.query;

    // Build where clause
    const where = {};
    if (category) {
      where.documentCategory = category;
    }

    // Patient ID filter
    let patientWhere = {};
    if (uhid) {
      patientWhere.uhid = uhid;
    }

    // If user is a patient, only show their own documents
    if (req.user.role === 'patient') {
      // Find the patient record linked to this user
      const patient = await Patient.findOne({ where: { UserId: req.user.id } });
      if (!patient) {
        return error(res, 'Your patient profile is not linked to your account. Please contact support.', 404);
      }
      where.PatientId = patient.id;
    }

    // Fetch documents
    const documents = await MedicalDocument.findAll({
      where,
      include: [
        {
          model: Patient,
          attributes: ['uhid', 'firstName', 'lastName'],
          where: Object.keys(patientWhere).length > 0 ? patientWhere : undefined,
        },
        { model: User, as: 'uploader', attributes: ['firstName', 'lastName'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    return success(res, {
      documents: documents.map(formatDocument),
      total: documents.length,
    });
  } catch (err) {
    console.error('List documents error:', err.message);
    return error(res, 'Failed to retrieve documents. Please try again.', 500);
  }
};

/**
 * PUT /api/documents/:id/status
 * Review or archive a document
 *
 * Authorization: doctor only
 */
const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['Pending Review', 'Reviewed', 'Archived'];
    if (!status) {
      return error(res, 'Status is required. Please provide a status value.', 400);
    }
    if (!validStatuses.includes(status)) {
      return error(res, `Invalid status '${status}'. Allowed values: Pending Review, Reviewed, Archived`, 400);
    }

    // Find document
    const document = await MedicalDocument.findByPk(id);
    if (!document) {
      return error(res, `Document with ID ${id} not found. Please verify the document ID.`, 404);
    }

    // Update status
    const updates = { status };

    // If marking as Reviewed, record who reviewed and when
    if (status === 'Reviewed') {
      const reviewer = await User.findByPk(req.user.id);
      // Add title prefix based on role
      const prefix = reviewer.role === 'doctor' ? 'Dr. ' : '';
      updates.reviewedBy = `${prefix}${reviewer.firstName} ${reviewer.lastName}`;
      updates.reviewDate = new Date();
    }

    await document.update(updates);

    // Fetch updated document with associations
    const fullDocument = await MedicalDocument.findByPk(document.id, {
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'uploader', attributes: ['firstName', 'lastName'] },
      ],
    });

    return success(res, formatDocument(fullDocument));
  } catch (err) {
    console.error('Update document status error:', err.message);
    return error(res, 'Failed to update document status. Please try again.', 500);
  }
};

/**
 * DELETE /api/documents/:id
 * Delete a document
 *
 * Authorization: doctor, staff
 */
const destroy = async (req, res) => {
  try {
    const { id } = req.params;

    // Find document
    const document = await MedicalDocument.findByPk(id);
    if (!document) {
      return error(res, `Document with ID ${id} not found. It may have already been deleted.`, 404);
    }

    // Delete physical file
    if (fs.existsSync(document.filePath)) {
      fs.unlinkSync(document.filePath);
    }

    // Delete database record
    await document.destroy();

    return success(res, { message: 'Document deleted successfully' });
  } catch (err) {
    console.error('Delete document error:', err.message);
    return error(res, 'Failed to delete document. Please try again.', 500);
  }
};

/**
 * GET /api/documents/file/:filename
 * Serve a document file (authenticated)
 *
 * Authorization: patient (own only), doctor, staff
 */
const serveFile = async (req, res) => {
  try {
    const { filename } = req.params;

    // Find document by filename in fileUrl
    const document = await MedicalDocument.findOne({
      where: { fileUrl: `/uploads/documents/${filename}` },
      include: [{ model: Patient, attributes: ['id', 'UserId'] }],
    });

    if (!document) {
      return error(res, `File '${filename}' not found in database. The document may have been deleted.`, 404);
    }

    // Authorization: patients can only access their own documents
    if (req.user.role === 'patient') {
      const patient = await Patient.findOne({ where: { UserId: req.user.id } });
      if (!patient || document.PatientId !== patient.id) {
        return error(res, 'Access denied. You do not have permission to view this document.', 403);
      }
    }

    // Check if file exists
    if (!fs.existsSync(document.filePath)) {
      return error(res, `Physical file '${filename}' not found on server. The file may have been moved or deleted.`, 404);
    }

    // Send file
    res.sendFile(path.resolve(document.filePath));
  } catch (err) {
    console.error('Serve file error:', err.message);
    return error(res, 'Failed to retrieve file. Please try again.', 500);
  }
};

// EXPORTS

module.exports = {
  upload,
  list,
  updateStatus,
  destroy,
  serveFile,
};
