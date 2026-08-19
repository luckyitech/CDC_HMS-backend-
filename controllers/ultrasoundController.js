const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { PERMISSIONS, hasPermission } = require('../constants/permissions');
const db = require('../models');
const { broadcast } = require('../utils/sseManager');

const { UltrasoundImage, Patient, ThyroidUltrasound } = db;
const { Op } = db.Sequelize;

// Mark each image "reported" when its patient has a (non-deleted) thyroid report.
// Per-patient signal: the machine stills aren't linked to reports directly (the
// report embeds edited copies), so a study counts as reported once its patient
// has a thyroid report. Unmatched images (no PatientId) are always unreported.
const attachReported = async (images) => {
  const patientIds = [...new Set(images.map((i) => i.PatientId).filter(Boolean))];
  const reported = new Set();
  if (patientIds.length) {
    const reps = await ThyroidUltrasound.findAll({
      where: { PatientId: { [Op.in]: patientIds }, status: { [Op.ne]: 'deleted' } },
      attributes: ['PatientId'], group: ['PatientId'],
    });
    reps.forEach((r) => reported.add(r.PatientId));
  }
  return images.map((img) => ({ ...formatImage(img), reported: img.PatientId ? reported.has(img.PatientId) : false }));
};

// ====================================
// HELPERS
// ====================================

const formatImage = (img) => ({
  id: img.id,
  uhid: img.Patient ? img.Patient.uhid : null,
  patientName: img.Patient ? `${img.Patient.firstName} ${img.Patient.lastName}` : null,
  dicomPatientId: img.dicomPatientId,
  dicomPatientName: img.patientName,       // as typed on the machine
  dicomBirthDate: img.patientBirthDate,    // as typed on the machine
  studyInstanceUid: img.studyInstanceUid,
  sopInstanceUid: img.sopInstanceUid,
  studyDate: img.studyDate,
  studyDescription: img.studyDescription,
  isMultiframe: img.isMultiframe,
  fileName: img.fileName,
  fileUrl: img.fileUrl,
  status: img.status,
  isArchived: img.isArchived,
  receivedAt: img.receivedAt,
  createdAt: img.createdAt,
});

// Delete an uploaded temp file without failing the request if cleanup fails
const cleanupFile = (file) => {
  if (file && file.path) {
    fs.unlink(file.path, () => {});
  }
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/ultrasound/ingest   (auth: x-ingest-key — DICOM bridge only)
 *
 * multipart/form-data:
 *   file             PNG (required)
 *   sopInstanceUid   DICOM SOP Instance UID (required — dedupe key)
 *   dicomPatientId   Patient ID as typed on the HS70A (required)
 *   studyDate        YYYY-MM-DD (optional)
 *   studyDescription (optional)
 *   isMultiframe     'true'|'false' (optional)
 *   receivedAt       ISO timestamp from the bridge (optional)
 *
 * Idempotent: a duplicate sopInstanceUid returns 200 with duplicate:true and
 * does NOT create a second row — the bridge retries safely.
 */
const ingest = async (req, res) => {
  try {
    const {
      sopInstanceUid, dicomPatientId, studyDate, studyDescription, isMultiframe, receivedAt,
      patientName, patientBirthDate, studyInstanceUid,
    } = req.body;

    if (!req.file) {
      return error(res, 'No file uploaded. Field name must be "file".', 400);
    }
    if (!sopInstanceUid || !dicomPatientId) {
      cleanupFile(req.file);
      return error(res, 'sopInstanceUid and dicomPatientId are required.', 400);
    }

    // Dedupe — the HS70A / bridge may resend the same object
    const existing = await UltrasoundImage.findOne({ where: { sopInstanceUid } });
    if (existing) {
      cleanupFile(req.file); // keep the original file, discard the resend
      return success(res, { duplicate: true, id: existing.id });
    }

    // Resolve the typed patient ID against Patients.uhid
    let patientId = null;
    let matched = false;
    const resolved = await resolvePatient(String(dicomPatientId).trim());
    if (resolved && !resolved.isDeactivated) {
      patientId = resolved.patient.id;
      matched = true;
    }

    const image = await UltrasoundImage.create({
      PatientId: patientId,
      dicomPatientId: String(dicomPatientId).trim(),
      patientName: patientName || null,
      patientBirthDate: patientBirthDate || null,
      studyInstanceUid: studyInstanceUid || null,
      sopInstanceUid,
      studyDate: studyDate || null,
      studyDescription: studyDescription || null,
      isMultiframe: String(isMultiframe) === 'true',
      fileName: req.file.originalname || req.file.filename,
      filePath: req.file.path,
      fileUrl: `/uploads/ultrasound/${req.file.filename}`,
      status: matched ? 'Matched' : 'Unassigned',
      receivedAt: receivedAt || new Date(),
    });

    // Notify connected clients (gallery re-fetches over the authenticated API).
    // Payload carries no clinical data beyond the uhid routing hint.
    broadcast('ultrasound_received', {
      id: image.id,
      uhid: matched ? resolved.patient.uhid : null,
      matched,
    });

    return success(res, { duplicate: false, id: image.id, matched }, 201);
  } catch (err) {
    cleanupFile(req.file);
    // Race on the unique index (two retries landing together) — treat as duplicate
    if (err.name === 'SequelizeUniqueConstraintError') {
      return success(res, { duplicate: true });
    }
    console.error('Ultrasound ingest error:', err.message);
    return error(res, 'Failed to ingest ultrasound image.', 500);
  }
};

/**
 * GET /api/ultrasound?uhid=...        — a patient's images (Matched)
 * GET /api/ultrasound?unassigned=1    — the Unassigned queue
 *
 * Authorization: doctor, nurse, admin
 */
const list = async (req, res) => {
  try {
    const { uhid, unassigned, inbox } = req.query;
    const isAdmin = hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS) || req.user.role === 'admin';

    const baseWhere = isAdmin ? {} : { isArchived: false };

    // Machine inbox: everything received and not yet explicitly removed from
    // the list (regardless of whether it has been attached to a patient).
    if (String(inbox) === '1' || String(inbox) === 'true') {
      const images = await UltrasoundImage.findAll({
        where: { ...baseWhere, inInbox: true },
        include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
        order: [['receivedAt', 'DESC']],
      });
      return success(res, await attachReported(images));
    }

    if (String(unassigned) === '1' || String(unassigned) === 'true') {
      const images = await UltrasoundImage.findAll({
        where: { ...baseWhere, status: 'Unassigned' },
        order: [['receivedAt', 'DESC']],
      });
      return success(res, await attachReported(images));
    }

    if (!uhid) {
      return error(res, 'uhid is required (or pass unassigned=1).', 400);
    }

    const resolved = await resolvePatient(uhid);
    if (!resolved) {
      return error(res, `Patient with UHID '${uhid}' not found.`, 404);
    }

    // The patient's image safe: always excludes archived images, even for
    // admins (an admin who archives one expects it to disappear here). Archived
    // images are managed separately; nothing is ever hard-deleted.
    const images = await UltrasoundImage.findAll({
      where: { isArchived: false, PatientId: resolved.patientIds },
      include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
      order: [['receivedAt', 'ASC']], // received-order — the PDF export order (v1)
    });

    return success(res, await attachReported(images));
  } catch (err) {
    console.error('Ultrasound list error:', err.message);
    return error(res, 'Failed to fetch ultrasound images.', 500);
  }
};

/**
 * GET /api/ultrasound/studies
 * The Ultrasound Studio worklist: every received image grouped into studies
 * (by StudyInstanceUID, falling back to machine-patient-id + study date).
 * Sorting/searching happens client-side.
 *
 * Authorization: doctor, nurse, admin
 */
const studies = async (req, res) => {
  try {
    const isAdmin = hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS) || req.user.role === 'admin';
    const where = isAdmin ? {} : { isArchived: false };

    const images = await UltrasoundImage.findAll({
      where,
      include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }],
      order: [['receivedAt', 'ASC']],
    });

    const map = new Map();
    for (const img of images) {
      const key = img.studyInstanceUid || `${img.dicomPatientId}|${img.studyDate || 'nodate'}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          dicomPatientId: img.dicomPatientId,
          patientName: img.patientName || null,       // as typed on the machine
          patientBirthDate: img.patientBirthDate || null,
          studyDate: img.studyDate,
          studyDescription: img.studyDescription,
          uhid: img.Patient ? img.Patient.uhid : null, // matched HMS patient (if any)
          hmsPatientName: img.Patient ? `${img.Patient.firstName} ${img.Patient.lastName}` : null,
          firstReceivedAt: img.receivedAt,
          lastReceivedAt: img.receivedAt,
          images: [],
        });
      }
      const s = map.get(key);
      s.images.push(formatImage(img));
      s.lastReceivedAt = img.receivedAt;
      if (!s.patientName && img.patientName) s.patientName = img.patientName;
      if (!s.patientBirthDate && img.patientBirthDate) s.patientBirthDate = img.patientBirthDate;
      if (!s.uhid && img.Patient) {
        s.uhid = img.Patient.uhid;
        s.hmsPatientName = `${img.Patient.firstName} ${img.Patient.lastName}`;
      }
    }

    // Newest studies first by default
    const list = [...map.values()].sort(
      (a, b) => new Date(b.lastReceivedAt) - new Date(a.lastReceivedAt),
    );
    return success(res, list);
  } catch (err) {
    console.error('Ultrasound studies error:', err.message);
    return error(res, 'Failed to fetch ultrasound studies.', 500);
  }
};

/**
 * GET /api/ultrasound/file/:filename
 * Serve an image file (authenticated). Mirrors documentController.serveFile.
 *
 * Authorization: doctor, nurse, admin
 */
const serveFile = async (req, res) => {
  try {
    const { filename } = req.params;

    const image = await UltrasoundImage.findOne({
      where: { fileUrl: `/uploads/ultrasound/${filename}` },
    });

    if (!image) {
      return error(res, `File '${filename}' not found.`, 404);
    }

    // Archived images are hidden from everyone except admins — 404, not 403,
    // so their existence is not revealed via direct links.
    const isAdmin = hasPermission(req.user, PERMISSIONS.ADMIN_ACCESS) || req.user.role === 'admin';
    if (image.isArchived && !isAdmin) {
      return error(res, `File '${filename}' not found.`, 404);
    }

    if (!fs.existsSync(image.filePath)) {
      return error(res, `Physical file '${filename}' not found on server.`, 404);
    }

    res.sendFile(path.resolve(image.filePath));
  } catch (err) {
    console.error('Ultrasound serve file error:', err.message);
    return error(res, 'Failed to retrieve file.', 500);
  }
};

/**
 * PUT /api/ultrasound/:id/assign   { uhid }
 * Manually link an Unassigned image to a patient.
 *
 * Authorization: doctor, nurse, admin
 */
const assign = async (req, res) => {
  try {
    const { id } = req.params;
    const { uhid } = req.body;

    if (!uhid) return error(res, 'uhid is required.', 400);

    const image = await UltrasoundImage.findByPk(id);
    if (!image || image.isArchived) {
      return error(res, 'Ultrasound image not found.', 404);
    }

    const resolved = await resolvePatient(String(uhid).trim());
    if (!resolved) {
      return error(res, `Patient with UHID '${uhid}' not found.`, 404);
    }
    if (resolved.isDeactivated) {
      return error(res, 'This patient record has been merged into another. Use the primary record.', 400);
    }

    image.PatientId = resolved.patient.id;
    image.status = 'Matched';
    await image.save();

    broadcast('ultrasound_received', {
      id: image.id,
      uhid: resolved.patient.uhid,
      matched: true,
    });

    return success(res, formatImage(image));
  } catch (err) {
    console.error('Ultrasound assign error:', err.message);
    return error(res, 'Failed to assign image.', 500);
  }
};

/**
 * PUT /api/ultrasound/inbox-dismiss   { ids: [1,2,3] }
 * Explicitly remove images from the machine-inbox list. This is the ONLY way
 * rows leave the inbox — attaching/saving never clears them. The images and
 * their patient links are untouched; only the inbox listing flag changes.
 *
 * Authorization: doctor, nurse, admin
 */
const dismissInbox = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return error(res, 'ids (non-empty array) is required.', 400);
    }
    const [count] = await UltrasoundImage.update(
      { inInbox: false },
      { where: { id: ids } },
    );
    return success(res, { dismissed: count });
  } catch (err) {
    console.error('Ultrasound inbox dismiss error:', err.message);
    return error(res, 'Failed to remove from inbox.', 500);
  }
};

/**
 * PUT /api/ultrasound/:id/archive   { reason }
 * Soft-delete (admin only). The file and row are never removed — medical data.
 *
 * Authorization: admin
 */
const archive = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const image = await UltrasoundImage.findByPk(id);
    if (!image) return error(res, 'Ultrasound image not found.', 404);
    if (image.isArchived) return error(res, 'Image is already archived.', 400);

    image.isArchived = true;
    image.archivedBy = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || String(req.user.id);
    image.archivedAt = new Date();
    image.archiveReason = reason || null;
    image.status = 'Archived';
    await image.save();

    return success(res, formatImage(image));
  } catch (err) {
    console.error('Ultrasound archive error:', err.message);
    return error(res, 'Failed to archive image.', 500);
  }
};

// -------------------------------------------------------------------
// saveEdited — persist a clinician-edited still (brightness/zoom/crop baked
// in on the client) into a patient's image safe as a NEW image. JWT-authed,
// merge-aware; leaves the original machine image untouched. Distinct from
// /ingest (machine auth) — this is a user action.
// -------------------------------------------------------------------
async function saveEdited(req, res) {
  try {
    if (!req.file) return error(res, 'No image file received.', 400);
    const { uhid, caption } = req.body;
    if (!uhid) { cleanupFile(req.file); return error(res, 'uhid is required.', 400); }

    const resolved = await resolvePatient(String(uhid).trim());
    if (!resolved) { cleanupFile(req.file); return error(res, 'Patient not found', 404); }
    if (resolved.isDeactivated) { cleanupFile(req.file); return error(res, 'This patient record is inactive (merged).', 403); }

    const created = await UltrasoundImage.create({
      PatientId: resolved.patient.id,
      dicomPatientId: String(uhid).trim(),
      patientName: `${resolved.patient.firstName} ${resolved.patient.lastName}`,
      sopInstanceUid: `edited-${crypto.randomBytes(12).toString('hex')}`,
      studyDate: new Date(),
      studyDescription: caption ? `Edited — ${caption}` : 'Edited image',
      isMultiframe: false,
      fileName: req.file.originalname || req.file.filename,
      filePath: req.file.path,
      fileUrl: `/uploads/ultrasound/${req.file.filename}`,
      status: 'Matched',
      inInbox: false,
      receivedAt: new Date(),
    });

    broadcast('ultrasound_received', { id: created.id, uhid: resolved.patient.uhid });
    const withPatient = await UltrasoundImage.findByPk(created.id, { include: [Patient] });
    return success(res, formatImage(withPatient), 201);
  } catch (err) {
    if (req.file) cleanupFile(req.file);
    console.error('Ultrasound saveEdited error:', err.message);
    return error(res, 'Failed to save edited image.', 500);
  }
}

module.exports = {
  ingest,
  list,
  studies,
  serveFile,
  assign,
  dismissInbox,
  archive,
  saveEdited,
};
