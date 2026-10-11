const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const { isSensitiveRegion, regionLabel } = require('../utils/dermRegions');
const {
  ensureDermPhotoDir, resolveDermPhoto, isJpeg, stripJpeg, cleanMarker,
} = require('../utils/dermPhotoStorage');
const { familyOfFinding, loadFinding, userName, USER_ATTRS } = require('./dermController');
const { cleanAreas } = require('../utils/dermCapture');
const db = require('../models');

const {
  sequelize, User, Patient, DermFinding, DermObservation, DermConsent, DermPhoto, DermPhotoView, DermPhotoRegion,
} = db;

// =====================================================================
// Dermatology Phase 2 — photography consent and skin photos (7 Oct 2026).
//
// Rules (decisions D9, D10):
//   - No photo without the patient's CURRENT clinical consent (409 NO_CONSENT).
//   - A photo belongs to one finding; it is linked to that day's look when one
//     exists. Files live in private/derm-photos/, JPEG only, metadata stripped.
//   - Photos of a sensitive site (groin, buttocks) are flagged at upload; the
//     screen blurs them until opened. EVERY opening of a photo is logged.
//   - Doctors (or derm.record) see photos; other clinical staff see that
//     photos exist, not the pictures.
//   - Never deleted: "entered in error" hides a photo and keeps the file.
//   - The marker is the doctor's ellipse showing which mark is the finding —
//     never a measurement. Its uploader may move it on the day it was taken.
// =====================================================================

const PHOTO_TYPES = ['overview', 'close_up', 'dermoscopy'];

const parseMarker = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

const formatConsent = (c) => (c ? {
  id: c.id, clinical: !!c.clinical, teaching: !!c.teaching, note: c.note,
  recordedByName: userName(c.recordedBy), createdAt: c.createdAt,
} : null);

const formatPhoto = (p) => ({
  id: p.id,
  findingId: p.DermFindingId || null,
  fromPhone: !!p.captureSessionId,
  captureSessionId: p.captureSessionId || null,
  observationId: p.DermObservationId,
  visitDate: p.visitDate,
  photoType: p.photoType,
  // The areas it shows (none = an overview of the whole finding).
  regions: (p.areas || []).map((a) => a.region),
  regionLabels: (p.areas || []).map((a) => regionLabel(a.region)),
  // The size typed on the look it was taken with (never measured from the picture).
  lookSize: p.observation && p.observation.lengthMm !== null && p.observation.lengthMm !== undefined
    ? [p.observation.lengthMm, p.observation.widthMm, p.observation.depthMm].filter((v) => v !== null && v !== undefined).map(Number)
    : null,
  width: p.width,
  height: p.height,
  marker: parseMarker(p.marker),
  sensitive: !!p.sensitive,
  status: p.status,
  uploadedById: p.uploadedById,
  uploadedByName: userName(p.uploadedBy),
  createdAt: p.createdAt,
  errorReason: p.errorReason,
  errorByName: userName(p.errorBy),
  errorAt: p.errorAt,
});

const PHOTO_INCLUDES = [
  { model: DermPhotoRegion, as: 'areas', attributes: ['region'] },
  { model: DermObservation, as: 'observation', attributes: ['lengthMm', 'widthMm', 'depthMm'], required: false },
  { model: User, as: 'uploadedBy', attributes: USER_ATTRS },
  { model: User, as: 'errorBy', attributes: USER_ATTRS },
];

/** The current consent across a merge family (newest row), with history. */
const consentFor = async (patientIds) => {
  const rows = await DermConsent.findAll({
    where: { PatientId: { [Op.in]: patientIds } },
    include: [{ model: User, as: 'recordedBy', attributes: USER_ATTRS }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
  });
  return { current: formatConsent(rows[0] || null), history: rows.map(formatConsent) };
};

// ---------------------------------------------------------------------
// GET /api/derm/patients/:uhid/consent
// ---------------------------------------------------------------------
const getConsent = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    return success(res, await consentFor(family.patientIds));
  } catch (err) {
    console.error('DermConsent.get error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/derm/patients/:uhid/consent — { clinical, teaching, note? }
// ---------------------------------------------------------------------
// A new row each time (consent given, changed or withdrawn); nothing is
// overwritten. Withdrawing clinical consent stops new photos; photos already
// taken stay in the record.
const recordConsent = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);
    const { clinical, teaching, note } = req.body || {};
    if (typeof clinical !== 'boolean') return error(res, 'Say whether the patient agrees to clinical photographs', 400, { field: 'clinical' });
    if (teaching !== undefined && typeof teaching !== 'boolean') return error(res, 'Teaching consent must be yes or no', 400, { field: 'teaching' });
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;
    await DermConsent.create({
      PatientId: family.patient.id, clinical, teaching: clinical ? !!teaching : false,
      note: cleanNote, recordedById: req.user.id,
    });
    return success(res, await consentFor(family.patientIds));
  } catch (err) {
    console.error('DermConsent.record error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/patients/:uhid/photos  (?findingId=, ?unlinked=true, ?includeErrors=true)
// ---------------------------------------------------------------------
// Metadata only — the pictures come one at a time through /photos/:id/file.
// Every photo of the family: those of its findings and its area photos (no
// finding yet, 8 Oct 2026). ?findingId= one finding's; ?unlinked=true area photos only.
const listPhotos = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const findings = await DermFinding.findAll({ where: { PatientId: { [Op.in]: family.patientIds } }, attributes: ['id'] });
    const ids = findings.map((f) => f.id);
    let where;
    if (req.query.findingId) {
      where = { DermFindingId: ids.includes(Number(req.query.findingId)) ? Number(req.query.findingId) : 0 };
    } else if (req.query.unlinked === 'true') {
      where = { DermFindingId: null, PatientId: { [Op.in]: family.patientIds } };
    } else {
      where = { [Op.or]: [
        { DermFindingId: { [Op.in]: ids.concat([0]) } },
        { DermFindingId: null, PatientId: { [Op.in]: family.patientIds } },
      ] };
    }
    if (req.query.includeErrors !== 'true') where.status = 'active';
    const photos = await DermPhoto.findAll({ where, include: PHOTO_INCLUDES, order: [['visitDate', 'DESC'], ['id', 'DESC']] });
    return success(res, { today: clinicToday(), photos: photos.map(formatPhoto), consent: (await consentFor(family.patientIds)).current });
  } catch (err) {
    console.error('DermPhoto.list error:', err);
    return error(res, 'Server error', 500);
  }
};

/**
 * Checks a photo file and stores it with its areas — the one writer for every
 * skin photo (a finding's, an area photo, one from a phone).
 *   file        multer file (memory)
 *   finding     the finding (with regions) or null for an area photo
 *   patientId   the canonical patient
 *   areas       already-cleaned region ids
 * Returns { photo } or { refuse: [code, message, extra] }.
 */
const storePhoto = async ({ file, photoType: rawType, marker: rawMarker, finding, patientId, areas, uploadedById, captureSessionId = null }) => {
  if (!file) return { refuse: [400, 'No photo was sent'] };
  if (!isJpeg(file.buffer)) return { refuse: [400, 'A skin photo is sent as a JPEG image', { code: 'NOT_JPEG' }] };
  const photoType = rawType || 'close_up';
  if (!PHOTO_TYPES.includes(photoType)) return { refuse: [400, `Photo type must be one of: ${PHOTO_TYPES.join(', ')}`] };
  const marker = cleanMarker(rawMarker);
  if (marker === undefined) return { refuse: [400, 'The marker could not be read', { field: 'marker' }] };

  let clean;
  try { clean = stripJpeg(file.buffer); } catch { return { refuse: [400, 'The photo file is damaged — take it again', { code: 'BAD_JPEG' }] }; }

  const today = clinicToday();
  const todayLook = finding ? await DermObservation.findOne({ where: { DermFindingId: finding.id, visitDate: today, status: 'active' } }) : null;
  const findingRegions = finding ? (finding.regions || []).map((r) => r.region) : [];
  // A face photo is not blurred because the same rash also reaches the groin.
  const sensitive = areas.length ? areas.some((r) => isSensitiveRegion(r)) : findingRegions.some((r) => isSensitiveRegion(r));

  const dir = ensureDermPhotoDir();
  const fileName = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  const written = path.join(dir, fileName);
  await fs.promises.writeFile(written, clean.buffer, { flag: 'wx' });
  try {
    const photo = await sequelize.transaction(async (transaction) => {
      const row = await DermPhoto.create({
        DermFindingId: finding ? finding.id : null,
        PatientId: patientId,
        DermObservationId: todayLook ? todayLook.id : null,
        captureSessionId,
        visitDate: today,
        photoType,
        fileName,
        sizeBytes: clean.buffer.length,
        width: clean.width,
        height: clean.height,
        marker: marker ? JSON.stringify(marker) : null,
        sensitive,
        uploadedById,
      }, { transaction });
      if (areas.length) await DermPhotoRegion.bulkCreate(areas.map((region) => ({ DermPhotoId: row.id, region })), { transaction });
      return row;
    });
    return { photo: await DermPhoto.findByPk(photo.id, { include: PHOTO_INCLUDES }) };
  } catch (err) {
    fs.promises.unlink(written).catch(() => {});
    throw err;
  }
};

const refuseWith = (res, refuse) => error(res, refuse[1], refuse[0], refuse[2]);

// ---------------------------------------------------------------------
// POST /api/derm/findings/:id/photos — multipart: photo (JPEG), photoType, marker?, regions? (JSON array)
// ---------------------------------------------------------------------
const uploadPhoto = async (req, res) => {
  try {
    const finding = await loadFinding(req.params.id);
    if (!finding) return error(res, 'Finding not found', 404);
    if (finding.status === 'entered_in_error') return error(res, 'This finding was entered in error', 409);
    const { family, refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);

    const { current } = await consentFor(family.patientIds);
    if (!current || !current.clinical) {
      return error(res, 'Record the patient\'s consent to clinical photographs first', 409, { code: 'NO_CONSENT' });
    }
    // The areas the photo shows: any of THIS finding's regions, or none (overview).
    const findingRegions = (finding.regions || []).map((r) => r.region);
    const areas = cleanAreas(req.body.regions);
    if (!areas.ok) return error(res, areas.message, 400, { field: 'regions' });
    if (areas.value.some((r) => !findingRegions.includes(r))) {
      return error(res, 'A photo can only be attached to this finding\'s own areas', 400, { field: 'regions' });
    }
    const out = await storePhoto({
      file: req.file, photoType: req.body.photoType, marker: req.body.marker,
      finding, patientId: family.patient.id, areas: areas.value, uploadedById: req.user.id,
    });
    if (out.refuse) return refuseWith(res, out.refuse);
    return success(res, formatPhoto(out.photo), 201);
  } catch (err) {
    console.error('DermPhoto.upload error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/derm/patients/:uhid/photos — an AREA photo (no finding yet)
// multipart: photo (JPEG), photoType, marker?, regions (JSON array)
// ---------------------------------------------------------------------
const uploadAreaPhoto = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);
    const { current } = await consentFor(family.patientIds);
    if (!current || !current.clinical) {
      return error(res, 'Record the patient\'s consent to clinical photographs first', 409, { code: 'NO_CONSENT' });
    }
    const areas = cleanAreas(req.body.regions);
    if (!areas.ok) return error(res, areas.message, 400, { field: 'regions' });
    if (!areas.value.length) return error(res, 'Choose the area the photo shows', 400, { field: 'regions' });
    const out = await storePhoto({
      file: req.file, photoType: req.body.photoType, marker: req.body.marker,
      finding: null, patientId: family.patient.id, areas: areas.value, uploadedById: req.user.id,
    });
    if (out.refuse) return refuseWith(res, out.refuse);
    return success(res, formatPhoto(out.photo), 201);
  } catch (err) {
    console.error('DermPhoto.uploadArea error:', err);
    return error(res, 'Server error', 500);
  }
};

/** The family a photo belongs to (its finding's, or its own patient's for an area photo). */
const familyOfPhoto = async (photo) => {
  if (photo.DermFindingId) {
    const finding = await loadFinding(photo.DermFindingId);
    if (!finding) return { refuse: [404, 'Finding not found'] };
    return familyOfFinding(finding);
  }
  const owner = photo.PatientId ? await Patient.findByPk(photo.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] }) : null;
  if (!owner) return { refuse: [404, 'Patient not found'] };
  const canonical = owner.mergedIntoId ? await Patient.findByPk(owner.mergedIntoId, { attributes: ['id', 'uhid'] }) : owner;
  const family = canonical ? await resolvePatient(canonical.uhid) : null;
  if (!family) return { refuse: [404, 'Patient not found'] };
  if (family.isDeactivated) return { refuse: [403, 'This patient file is inactive (merged). Open the active file.'] };
  return { family };
};

// ---------------------------------------------------------------------
// PUT /api/derm/photos/:id/link — { findingId } — file an area photo under a finding
// ---------------------------------------------------------------------
const linkPhoto = async (req, res) => {
  try {
    const photo = await DermPhoto.findByPk(req.params.id);
    if (!photo || photo.status !== 'active') return error(res, 'Photo not found', 404);
    if (photo.DermFindingId) return error(res, 'This photo already belongs to a finding', 409, { code: 'ALREADY_LINKED' });
    const { family, refuse } = await familyOfPhoto(photo);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const finding = await loadFinding(Number(req.body?.findingId));
    if (!finding || finding.status === 'entered_in_error' || !family.patientIds.includes(finding.PatientId)) {
      return error(res, 'Choose one of this patient\'s findings', 400, { field: 'findingId' });
    }
    const today = clinicToday();
    const look = photo.visitDate === today
      ? await DermObservation.findOne({ where: { DermFindingId: finding.id, visitDate: today, status: 'active' } }) : null;
    await photo.update({ DermFindingId: finding.id, DermObservationId: look ? look.id : photo.DermObservationId });
    const full = await DermPhoto.findByPk(photo.id, { include: PHOTO_INCLUDES });
    return success(res, formatPhoto(full));
  } catch (err) {
    console.error('DermPhoto.link error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/photos/:id/file — the picture itself; every opening logged
// ---------------------------------------------------------------------
const sendPhotoFile = async (req, res) => {
  try {
    const photo = await DermPhoto.findByPk(req.params.id);
    if (!photo || photo.status !== 'active') return error(res, 'Photo not found', 404);
    const file = resolveDermPhoto(photo.fileName);
    if (!file) return error(res, 'Photo file missing', 404);
    await DermPhotoView.create({ DermPhotoId: photo.id, viewedById: req.user.id });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'image/jpeg');
    return res.sendFile(file);
  } catch (err) {
    console.error('DermPhoto.file error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/photos/:id/views — who opened this photo, newest first
// ---------------------------------------------------------------------
const photoViews = async (req, res) => {
  try {
    const photo = await DermPhoto.findByPk(req.params.id, { attributes: ['id'] });
    if (!photo) return error(res, 'Photo not found', 404);
    const views = await DermPhotoView.findAll({
      where: { DermPhotoId: photo.id },
      include: [{ model: User, as: 'viewedBy', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });
    return success(res, views.map((v) => ({ id: v.id, viewedByName: userName(v.viewedBy), createdAt: v.createdAt })));
  } catch (err) {
    console.error('DermPhoto.views error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/derm/photos/:id/marker — { marker | null }
// ---------------------------------------------------------------------
// Only its uploader, on the day it was taken (MARKER_LOCKED after that).
const setMarker = async (req, res) => {
  try {
    const photo = await DermPhoto.findByPk(req.params.id, { include: PHOTO_INCLUDES });
    if (!photo || photo.status !== 'active') return error(res, 'Photo not found', 404);
    if (photo.uploadedById !== req.user.id || photo.visitDate !== clinicToday()) {
      return error(res, 'Only the person who took the photo can move its marker, on the day it was taken', 409, { code: 'MARKER_LOCKED' });
    }
    const { refuse } = await familyOfPhoto(photo);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const marker = cleanMarker(req.body?.marker);
    if (marker === undefined) return error(res, 'The marker could not be read', 400, { field: 'marker' });
    await photo.update({ marker: marker ? JSON.stringify(marker) : null });
    return success(res, formatPhoto(photo));
  } catch (err) {
    console.error('DermPhoto.marker error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/derm/photos/:id/entered-in-error — { reason }
// ---------------------------------------------------------------------
const photoInError = async (req, res) => {
  try {
    const photo = await DermPhoto.findByPk(req.params.id, { include: PHOTO_INCLUDES });
    if (!photo) return error(res, 'Photo not found', 404);
    if (photo.status !== 'active') return error(res, 'Already marked entered in error', 409);
    const { refuse } = await familyOfPhoto(photo);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Give a reason', 400, { code: 'REASON_REQUIRED' });
    await sequelize.transaction(async (transaction) => {
      await photo.update({ status: 'entered_in_error', errorReason: reason.slice(0, 500), errorById: req.user.id, errorAt: new Date() }, { transaction });
    });
    const full = await DermPhoto.findByPk(photo.id, { include: PHOTO_INCLUDES });
    return success(res, formatPhoto(full));
  } catch (err) {
    console.error('DermPhoto.inError error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = {
  getConsent, recordConsent, listPhotos, uploadPhoto, uploadAreaPhoto, linkPhoto, sendPhotoFile, photoViews, setMarker, photoInError,
  // shared with dermCaptureController (the phone hand-off)
  storePhoto, consentFor, formatPhoto, PHOTO_INCLUDES,
};
