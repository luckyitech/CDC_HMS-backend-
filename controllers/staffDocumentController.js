const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');
const fs = require('fs');
const path = require('path');

const { StaffDocument, User } = db;

// ====================================
// CONSTANTS
// ====================================

// Staff document categories. Free-ish but validated against this list so the
// data stays reportable (unlike a free-text field).
const ALLOWED_CATEGORIES = [
  'Practising Licence',
  'Qualification',
  'Training',
  'Identification',
  'HR',
  'Other',
];

// Roles that can hold a staff file. Patients are excluded outright — they are
// subjects of records, not staff members.
const STAFF_ROLES = ['doctor', 'staff', 'lab', 'nurse', 'admin'];

// ====================================
// HELPERS
// ====================================

const formatFileSize = (bytes) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatDoc = (doc) => ({
  id: doc.id,
  documentId: doc.documentId,
  staffUserId: doc.staffUserId,
  uploadedBy: doc.uploader ? `${doc.uploader.firstName} ${doc.uploader.lastName}` : null,
  documentCategory: doc.documentCategory,
  fileName: doc.fileName,
  fileSize: doc.fileSize,
  fileUrl: doc.fileUrl,
  expiryDate: doc.expiryDate,
  notes: doc.notes,
  status: doc.status,
  archivedBy: doc.archivedBy,
  archivedAt: doc.archivedAt,
  archiveReason: doc.archiveReason,
  uploadedAt: doc.createdAt,
});

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/staff-documents
 * Upload a staff document (multipart/form-data). Admin only.
 */
const upload = async (req, res) => {
  try {
    if (!req.file) {
      return error(res, 'No file uploaded. Please select a file to upload.', 400);
    }

    const { staffUserId, documentCategory, expiryDate, notes } = req.body;

    if (req.file.originalname.length > 255) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Filename is too long. Maximum 255 characters allowed.', 400);
    }
    if (!staffUserId) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Staff member is required.', 400);
    }
    if (documentCategory && !ALLOWED_CATEGORIES.includes(documentCategory)) {
      fs.unlinkSync(req.file.path);
      return error(res, `Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}`, 400);
    }
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Invalid expiry date format. Use YYYY-MM-DD.', 400);
    }
    if (notes && notes.length > 5000) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Notes are too long. Maximum 5000 characters allowed.', 400);
    }

    // The staff member must exist and be an actual staff role, not a patient.
    const staffUser = await User.findByPk(staffUserId);
    if (!staffUser || !STAFF_ROLES.includes(staffUser.role)) {
      fs.unlinkSync(req.file.path);
      return error(res, 'Staff member not found.', 404);
    }

    const document = await StaffDocument.create({
      documentId:       `SDOC-${Date.now()}`,
      staffUserId:      staffUser.id,
      uploadedById:     req.user.id,
      documentCategory: documentCategory || 'Other',
      fileName:         req.file.originalname,
      filePath:         req.file.path,
      fileSize:         formatFileSize(req.file.size),
      fileUrl:          `/uploads/documents/${req.file.filename}`,
      expiryDate:       expiryDate || null,
      notes:            notes || null,
      status:           'active',
    });

    const full = await StaffDocument.findByPk(document.id, {
      include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }],
    });

    return success(res, formatDoc(full), 201);
  } catch (err) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('StaffDocument.upload error:', err);
    return error(res, 'Failed to upload document. Please try again.', 500);
  }
};

/**
 * GET /api/staff-documents?staffUserId=&archived=true
 * List a staff member's documents. Admin only.
 */
const list = async (req, res) => {
  try {
    const { staffUserId, archived } = req.query;
    if (!staffUserId) {
      return error(res, 'staffUserId is required.', 400);
    }

    const where = {
      staffUserId,
      status: archived === 'true' ? 'archived' : 'active',
    };

    const documents = await StaffDocument.findAll({
      where,
      include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }],
      order: [['createdAt', 'DESC']],
    });

    return success(res, {
      documents: documents.map(formatDoc),
      total: documents.length,
    });
  } catch (err) {
    console.error('StaffDocument.list error:', err);
    return error(res, 'Failed to retrieve documents. Please try again.', 500);
  }
};

/**
 * PUT /api/staff-documents/:id/archive
 * Soft-delete a document — hides it from every view without removing the file
 * or row. Admin only.
 */
const archive = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const document = await StaffDocument.findByPk(id);
    if (!document) return error(res, 'Document not found.', 404);
    if (document.status === 'archived') return error(res, 'This document is already archived.', 400);
    if (reason && reason.length > 5000) return error(res, 'Reason is too long. Maximum 5000 characters allowed.', 400);

    const archiver = await User.findByPk(req.user.id);
    await document.update({
      status: 'archived',
      archivedBy: archiver ? `${archiver.firstName} ${archiver.lastName}` : null,
      archivedAt: new Date(),
      archiveReason: reason || null,
    });

    const full = await StaffDocument.findByPk(document.id, {
      include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }],
    });
    return success(res, formatDoc(full));
  } catch (err) {
    console.error('StaffDocument.archive error:', err);
    return error(res, 'Failed to archive document. Please try again.', 500);
  }
};

/**
 * PUT /api/staff-documents/:id/restore
 * Restore an archived document. Admin only.
 */
const restore = async (req, res) => {
  try {
    const { id } = req.params;
    const document = await StaffDocument.findByPk(id);
    if (!document) return error(res, 'Document not found.', 404);
    if (document.status !== 'archived') return error(res, 'This document is not archived.', 400);

    await document.update({ status: 'active', archivedBy: null, archivedAt: null, archiveReason: null });

    const full = await StaffDocument.findByPk(document.id, {
      include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }],
    });
    return success(res, formatDoc(full));
  } catch (err) {
    console.error('StaffDocument.restore error:', err);
    return error(res, 'Failed to restore document. Please try again.', 500);
  }
};

/**
 * GET /api/staff-documents/file/:filename
 * Serve a staff document file. Admin only — these are sensitive HR records, so
 * they are never exposed as static files, only through this authenticated route.
 */
const serveFile = async (req, res) => {
  try {
    const { filename } = req.params;
    const document = await StaffDocument.findOne({
      where: { fileUrl: `/uploads/documents/${filename}` },
    });
    if (!document) return error(res, 'File not found.', 404);

    if (!fs.existsSync(document.filePath)) {
      return error(res, 'Physical file not found on server.', 404);
    }
    res.sendFile(path.resolve(document.filePath));
  } catch (err) {
    console.error('StaffDocument.serveFile error:', err);
    return error(res, 'Failed to retrieve file. Please try again.', 500);
  }
};

module.exports = { upload, list, archive, restore, serveFile };
