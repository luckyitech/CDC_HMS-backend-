// Staff HR documents — contracts, certificates, licences, sick notes.
//
// findStaff has already resolved :employeeId onto req.staffProfile and
// req.staffUser. See STAFF_PROFILE_DESIGN.md.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const { canViewConfidential } = require('../constants/permissions');
const db = require('../models');

const { StaffDocument, User } = db;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'staff-documents');

const CATEGORIES = [
  'Employment Contract', 'National ID', 'Practising Licence',
  'Academic Certificate', 'CV', 'Training Certificate',
  'Sick Note', 'Appraisal', 'Disciplinary', 'Other',
];

const VISIBILITIES = ['Staff', 'Admin only'];

// The confidential drawer of a staff file: every document marked 'Admin only',
// and every archived document (archived ones are the most likely to be
// sensitive). Reading it, filling it, or moving a document in or out of it
// needs hr.confidential — an explicit grant that full administrator access
// does NOT carry (constants/permissions.js HR_CONFIDENTIAL). users.write still
// lets someone manage the rest of the file: rename a CV's category, archive a
// certificate, set an expiry.
//
// Used to be `role === 'admin'`, which both refused a doctor holding
// admin.access and let ANY admin read every contract. Now the two questions
// are separate on purpose.
const isConfidential = (document) => document.visibility !== 'Staff' || document.isArchived;

const formatSize = (bytes) => {
  if (!bytes && bytes !== 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// Days of notice before an expiry is worth flagging — the same threshold the
// profile licence pill uses, so the two never disagree.
const EXPIRY_WARNING_DAYS = 60;

const daysUntil = (date) => {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
};

const formatDocument = (doc) => {
  const expiresInDays = daysUntil(doc.expiryDate);

  return {
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

    expiryDate:     doc.expiryDate,
    expiresInDays,
    // Derived here so every screen flags the same document at the same moment.
    expiringSoon:   expiresInDays !== null && expiresInDays <= EXPIRY_WARNING_DAYS,
    expired:        expiresInDays !== null && expiresInDays < 0,

    isArchived:    doc.isArchived,
    archivedAt:    doc.archivedAt,
    archiveReason: doc.archiveReason,
  };
};

// Deleting the file from disk when the database row could not be written, so a
// failed upload does not leave an orphan behind.
const discard = (file) => {
  if (!file) return;
  fs.promises.unlink(file.path).catch(() => {});
};

/**
 * GET /api/staff/:employeeId/documents
 * A holder of hr.confidential sees everything; anyone else who may open the
 * file — an administrator without that grant, or the staff member viewing
 * their own file — sees only what is marked visible to staff. A contract or
 * disciplinary letter is not theirs to read from here.
 *
 * Authorization: users.view, or the staff member themselves (adminOrSelf)
 */
const list = async (req, res) => {
  const confidential = canViewConfidential(req.user);

  try {
    // Archived documents are hidden by default and only a confidential-drawer
    // holder can ask for them — they are the ones most likely to be sensitive.
    const wantsArchived = confidential && req.query.archived === 'true';

    const where = { UserId: req.staffUser.id, isArchived: wantsArchived };
    if (!confidential) where.visibility = 'Staff';

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
 * Authorization: users.view, or the staff member themselves (adminOrSelf)
 */
const upload = async (req, res) => {
  if (!req.file) return error(res, 'No file uploaded', 400);

  const { category, notes, expiryDate } = req.body;
  const confidential = canViewConfidential(req.user);

  try {
    if (category && !CATEGORIES.includes(category)) {
      discard(req.file);
      return error(res, 'Invalid document category', 400);
    }

    // Validated here rather than left to MySQL, which would reject it with a
    // driver error after the file had already been written to disk.
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      discard(req.file);
      return error(res, 'Expiry date must be in YYYY-MM-DD format', 400);
    }

    // Only a confidential-drawer holder chooses visibility. Anything anyone
    // else uploads — a staff member about themselves, an administrator without
    // the grant — is visible to the staff member by definition; letting them
    // file into the drawer would let them create a document they cannot see.
    let visibility = 'Admin only';
    if (confidential) {
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
      expiryDate: expiryDate || null,
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
 * Authorization: users.write at the route. A document in the confidential
 * drawer, and any change of visibility, additionally needs hr.confidential —
 * without that, "share with staff" would be a one-click way to read a
 * contract the caller cannot otherwise see.
 */
const update = async (req, res) => {
  const { category, visibility, notes, expiryDate } = req.body;

  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);

    if ((isConfidential(document) || visibility !== undefined) && !canViewConfidential(req.user)) {
      return error(res, 'Only a holder of confidential staff documents can do that', 403);
    }

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
    if (expiryDate !== undefined) {
      if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
        return error(res, 'Expiry date must be in YYYY-MM-DD format', 400);
      }
      // Empty means "no expiry", which has to reach the column as null.
      updates.expiryDate = expiryDate || null;
    }

    if (!Object.keys(updates).length) return error(res, 'No changes supplied', 400);

    // Attribution comes from the JWT, never the request body.
    updates.updatedById = req.user.id;

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
 * Authorization: users.write at the route; hr.confidential on top for a
 * confidential document.
 */
const archive = async (req, res) => {
  const { reason } = req.body || {};

  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);
    if (isConfidential(document) && !canViewConfidential(req.user)) {
      return error(res, 'Only a holder of confidential staff documents can do that', 403);
    }
    if (document.isArchived) return error(res, 'This document is already archived', 400);
    if (reason && reason.length > 5000) return error(res, 'Reason is too long. Maximum 5000 characters.', 400);

    await document.update({
      isArchived:    true,
      archivedById:  req.user.id,
      archivedAt:    new Date(),
      archiveReason: reason || null,
    });

    return success(res, { id: document.id, archived: true });
  } catch (err) {
    console.error('Archive staff document error:', err.message);
    return error(res, 'Failed to archive document', 500);
  }
};

/**
 * PATCH /api/staff/:employeeId/documents/:id/restore
 * Undoes an archive. Archiving without a way back makes admins reluctant to
 * tidy up, which leaves the wrong documents on file.
 *
 * Authorization: users.write at the route; hr.confidential on top, because
 * the archive is part of the confidential drawer.
 */
const restore = async (req, res) => {
  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);
    if (!canViewConfidential(req.user)) {
      return error(res, 'Only a holder of confidential staff documents can do that', 403);
    }
    if (!document.isArchived) return error(res, 'This document is not archived', 400);

    await document.update({
      isArchived:    false,
      archivedById:  null,
      archivedAt:    null,
      archiveReason: null,
    });

    await document.reload({ include: [{ model: User, as: 'uploader', attributes: ['firstName', 'lastName'] }] });
    return success(res, formatDocument(document));
  } catch (err) {
    console.error('Restore staff document error:', err.message);
    return error(res, 'Failed to restore document', 500);
  }
};

/**
 * GET /api/staff/:employeeId/documents/:id/file
 * Streams the file through an authenticated route rather than serving the
 * upload directory statically — otherwise anyone holding a URL could read an
 * employment contract without logging in.
 *
 * Authorization: users.view or the staff member themselves (adminOrSelf);
 * a confidential document additionally needs hr.confidential
 */
const serveFile = async (req, res) => {
  const confidential = canViewConfidential(req.user);

  try {
    const document = await StaffDocument.findOne({
      where: { id: req.params.id, UserId: req.staffUser.id },
    });
    if (!document) return error(res, 'Document not found', 404);
    if (!confidential && isConfidential(document)) return error(res, 'Access denied', 403);

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

module.exports = { list, upload, update, archive, restore, serveFile, CATEGORIES, VISIBILITIES, isConfidential };
