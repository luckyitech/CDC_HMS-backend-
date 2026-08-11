// Staff HR documents — contracts, certificates, licences, sick notes.
//
// findStaff has already resolved :employeeId onto req.staffProfile and
// req.staffUser. See STAFF_PROFILE_DESIGN.md.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const db = require('../models');

const { StaffDocument, User } = db;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'staff-documents');

const CATEGORIES = [
  'Employment Contract', 'National ID', 'Practising Licence',
  'Academic Certificate', 'CV', 'Training Certificate',
  'Sick Note', 'Appraisal', 'Disciplinary', 'Other',
];

const VISIBILITIES = ['Staff', 'Admin only'];

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDocument = (doc) => ({
  id:         doc.id,
  documentId: doc.documentId,
  category:   doc.category,
  visibility: doc.visibility,
  fileName:   doc.fileName,
  fileSize:   doc.fileSize,
  fileUrl:    doc.fileUrl,
  notes:      doc.notes,
  uploadedBy: doc.uploader ? `${doc.uploader.firstName} ${doc.uploader.lastName}` : null,
  uploadedByRole: doc.uploadedByRole,
  uploadedAt: doc.createdAt,
});

// Deleting the file from disk when the database row could not be written, so a
// failed upload does not leave an orphan behind.
const discard = (file) => {
  if (!file) return;
  fs.promises.unlink(file.path).catch(() => {});
};

/**
 * GET /api/staff/:employeeId/documents
 * Admins see everything; a staff member viewing their own file sees only what
 * is marked visible to them — a contract or disciplinary letter is not theirs
 * to read from here.
 *
 * Authorization: Admin, or the staff member themselves
 */
const list = async (req, res) => {
  const isAdmin = req.user.role === 'admin';

  try {
    const where = { UserId: req.staffUser.id, isArchived: false };
    if (!isAdmin) where.visibility = 'Staff';

    const documents = await StaffDocument.findAll({
      where,
      include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }],
      order: [['createdAt', 'DESC']],
    });

    return success(res, documents.map(formatDocument));
  } catch (err) {
    console.error('List staff documents error:', err.message);
    return error(res, 'Failed to load documents', 500);
  }
};

/**
 * POST /api/staff/:employeeId/documents
 * Multipart upload. uploadStaffDocument has already validated extension and
 * MIME type and written the file.
 *
 * Authorization: Admin, or the staff member themselves
 */
const upload = async (req, res) => {
  if (!req.file) return error(res, 'No file uploaded', 400);

  const { category, notes } = req.body;
  const isAdmin = req.user.role === 'admin';

  try {
    if (category && !CATEGORIES.includes(category)) {
      discard(req.file);
      return error(res, 'Invalid document category', 400);
    }

    // Only an admin chooses visibility. Anything a staff member uploads about
    // themselves is visible to them by definition; letting them set it would
    // also let them mark their own document admin-only and lose sight of it.
    let visibility = 'Admin only';
    if (isAdmin) {
      if (req.body.visibility && !VISIBILITIES.includes(req.body.visibility)) {
        discard(req.file);
        return error(res, 'Invalid visibility', 400);
      }
      visibility = req.body.visibility || 'Admin only';
    } else {
      visibility = 'Staff';
    }

    const document = await StaffDocument.create({
      UserId:     req.staffUser.id,
      documentId: `SDOC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      category:   category || 'Other',
      visibility,
      fileName:   req.file.originalname,
      filePath:   req.file.path,
      fileSize:   formatSize(req.file.size),
      fileUrl:    `/uploads/staff-documents/${req.file.filename}`,
      uploadedById:   req.user.id,
      uploadedByRole: req.user.role,
      notes:      notes || null,
    });

    await document.reload({ include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }] });
    return success(res, formatDocument(document), 201);
  } catch (err) {
    discard(req.file);
    console.error('Upload staff document error:', err.message);
    return error(res, 'Failed to upload document', 500);
  }
};

/**
 * PATCH /api/staff/:employeeId/documents/:id
 * Reclassify a document or change who can see it.
 *
 * Authorization: Admin only
 */
const update = async (req, res) => {
  const { category, visibility, notes } = req.body;

  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);

    const updates = {};
    if (category !== undefined) {
      if (!CATEGORIES.includes(category)) return error(res, 'Invalid document category', 400);
      updates.category = category;
    }
    if (visibility !== undefined) {
      if (!VISIBILITIES.includes(visibility)) return error(res, 'Invalid visibility', 400);
      updates.visibility = visibility;
    }
    if (notes !== undefined) updates.notes = notes;

    if (!Object.keys(updates).length) return error(res, 'No changes supplied', 400);

    await document.update(updates);
    await document.reload({ include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }] });

    return success(res, formatDocument(document));
  } catch (err) {
    console.error('Update staff document error:', err.message);
    return error(res, 'Failed to update document', 500);
  }
};

/**
 * DELETE /api/staff/:employeeId/documents/:id
 * Archives the row and leaves the file on disk, matching how patient documents
 * behave. A contract removed by mistake is recoverable.
 *
 * Authorization: Admin only
 */
const archive = async (req, res) => {
  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);
    if (document.isArchived) return error(res, 'This document is already archived', 400);

    await document.update({
      isArchived:   true,
      archivedById: req.user.id,
      archivedAt:   new Date(),
    });

    return success(res, { id: document.id, archived: true });
  } catch (err) {
    console.error('Archive staff document error:', err.message);
    return error(res, 'Failed to archive document', 500);
  }
};

/**
 * GET /api/staff/:employeeId/documents/:id/file
 * Streams the file through an authenticated route rather than serving the
 * upload directory statically — otherwise anyone holding a URL could read an
 * employment contract without logging in.
 *
 * Authorization: Admin, or the staff member themselves for documents marked
 * visible to staff
 */
const serveFile = async (req, res) => {
  const isAdmin = req.user.role === 'admin';

  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);
    if (!isAdmin && document.visibility !== 'Staff') return error(res, 'Access denied', 403);

    // Resolve and confirm the file is inside the upload directory before
    // reading it, so a tampered filePath cannot be used to read other files.
    const resolved = path.resolve(document.filePath);
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
      console.error('Staff document path outside upload dir:', document.id);
      return error(res, 'Document unavailable', 404);
    }
    if (!fs.existsSync(resolved)) return error(res, 'File is missing from the server', 404);

    return res.download(resolved, document.fileName);
  } catch (err) {
    console.error('Serve staff document error:', err.message);
    return error(res, 'Failed to load document', 500);
  }
};

module.exports = { list, upload, update, archive, serveFile, CATEGORIES, VISIBILITIES };
