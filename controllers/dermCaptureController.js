const crypto = require('crypto');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { regionLabel } = require('../utils/dermRegions');
const { isModuleOn } = require('../services/clinicModules');
const {
  CAPTURE_MINUTES, newToken, hashToken, sameHash, cleanAreas, sessionProblem, splitAreas,
} = require('../utils/dermCapture');
const { loadFinding, familyOfFinding, userName } = require('./dermController');
const { storePhoto, consentFor, formatPhoto, PHOTO_INCLUDES } = require('./dermPhotoController');
const db = require('../models');

const { Patient, DermCaptureSession, DermPhoto, DermFinding } = db;

// =====================================================================
// Skin photos from a phone (8 Oct 2026, Emu).
//
// The computer asks for a hand-off; the doctor scans the QR with a phone;
// the phone page adds photos straight into the record. The QR's token is
// random, stored only as a hash, lasts CAPTURE_MINUTES, and is bound to the
// FIRST phone that opens it (a second phone is refused). The phone can only
// ADD photos — to this patient, these areas, and the finding being recorded.
// It can never read the record: the phone sees the patient's name, UHID, age
// and sex (to be sure it is the right patient) and the photos it sent itself.
// Consent to clinical photographs is checked when the QR is made AND on
// every upload. Photos are attributed to the doctor who made the QR.
// =====================================================================

const ageOf = (dob) => {
  if (!dob) return null;
  const d = new Date(dob); if (Number.isNaN(d.getTime())) return null;
  const n = new Date(); let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a -= 1;
  return a;
};

const sessionView = (s, photos = []) => ({
  id: s.id,
  purpose: s.purpose,
  findingId: s.DermFindingId || null,
  regions: splitAreas(s.regions),
  expiresAt: s.expiresAt,
  openedAt: s.openedAt,
  closedAt: s.closedAt,
  photoCount: s.photoCount,
  photos: photos.map(formatPhoto),
});

// ---------------------------------------------------------------------
// POST /api/derm/patients/:uhid/capture — { regions[], findingId?, purpose }
// → { session, token }   (signed-in doctor / derm.record)
// ---------------------------------------------------------------------
const createSession = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);
    const { current } = await consentFor(family.patientIds);
    if (!current || !current.clinical) {
      return error(res, 'Record the patient\'s consent to clinical photographs first', 409, { code: 'NO_CONSENT' });
    }
    const areas = cleanAreas(req.body?.regions);
    if (!areas.ok) return error(res, areas.message, 400, { field: 'regions' });
    const purpose = req.body?.purpose === 'finding' ? 'finding' : 'photos';
    let findingId = null;
    if (req.body?.findingId) {
      const finding = await loadFinding(Number(req.body.findingId));
      if (!finding || finding.status === 'entered_in_error' || !family.patientIds.includes(finding.PatientId)) {
        return error(res, 'Choose one of this patient\'s findings', 400, { field: 'findingId' });
      }
      findingId = finding.id;
    }
    if (purpose === 'photos' && !areas.value.length) return error(res, 'Choose the areas first', 400, { field: 'regions' });

    const token = newToken();
    const s = await DermCaptureSession.create({
      tokenHash: hashToken(token),
      PatientId: family.patient.id,
      doctorId: req.user.id,
      DermFindingId: findingId,
      purpose,
      regions: areas.value.join(',') || null,
      expiresAt: new Date(Date.now() + CAPTURE_MINUTES * 60 * 1000),
    });
    return success(res, { session: sessionView(s), token }, 201);
  } catch (err) {
    console.error('DermCaptureSession.create error:', err);
    return error(res, 'Server error', 500);
  }
};

/** The caller's own session (the doctor who made it). */
const ownSession = async (req) => {
  const s = await DermCaptureSession.findByPk(req.params.id);
  if (!s || s.doctorId !== req.user.id) return null;
  return s;
};

// GET /api/derm/capture/:id — the computer watches for photos arriving
const getSession = async (req, res) => {
  try {
    const s = await ownSession(req);
    if (!s) return error(res, 'Not found', 404);
    const photos = await DermPhoto.findAll({
      where: { captureSessionId: s.id, status: 'active' }, include: PHOTO_INCLUDES, order: [['id', 'ASC']],
    });
    return success(res, sessionView(s, photos));
  } catch (err) {
    console.error('DermCaptureSession.get error:', err);
    return error(res, 'Server error', 500);
  }
};

// PUT /api/derm/capture/:id — { regions } (areas changed on the computer)
const updateSession = async (req, res) => {
  try {
    const s = await ownSession(req);
    if (!s) return error(res, 'Not found', 404);
    const problem = sessionProblem(s);
    if (problem) return error(res, problem[1], problem[0]);
    const areas = cleanAreas(req.body?.regions);
    if (!areas.ok) return error(res, areas.message, 400, { field: 'regions' });
    await s.update({ regions: areas.value.join(',') || null });
    return success(res, sessionView(s));
  } catch (err) {
    console.error('DermCaptureSession.update error:', err);
    return error(res, 'Server error', 500);
  }
};

// POST /api/derm/capture/:id/close — the computer is finished with it
const closeSession = async (req, res) => {
  try {
    const s = await ownSession(req);
    if (!s) return error(res, 'Not found', 404);
    if (!s.closedAt) await s.update({ closedAt: new Date() });
    return success(res, sessionView(s));
  } catch (err) {
    console.error('DermCaptureSession.close error:', err);
    return error(res, 'Server error', 500);
  }
};

/**
 * Link a session's area photos to a finding just saved (called by
 * createFinding). Only the session's own doctor; only active, unlinked photos
 * of the same family. Later phone photos then go to the finding too.
 */
const attachSessionToFinding = async ({ sessionId, userId, finding, patientIds, transaction }) => {
  if (!sessionId) return 0;
  const s = await DermCaptureSession.findByPk(Number(sessionId), { transaction });
  if (!s || s.doctorId !== userId || !patientIds.includes(s.PatientId)) return 0;
  const [n] = await DermPhoto.update({ DermFindingId: finding.id }, {
    where: { captureSessionId: s.id, DermFindingId: null, status: 'active', PatientId: { [Op.in]: patientIds } }, transaction,
  });
  await s.update({ DermFindingId: finding.id }, { transaction });
  return n;
};

// =====================================================================
// The phone (no sign-in — the token is the key)
// =====================================================================

const findByToken = (token) => DermCaptureSession.findOne({
  where: { tokenHash: hashToken(token) },
  include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName', 'gender', 'dateOfBirth', 'mergedIntoId'] }],
});

const patientName = (p) => (p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : '');

// GET /api/derm-capture/:token  (header X-Capture-Key once bound)
const phoneOpen = async (req, res) => {
  try {
    if (!(await isModuleOn('dermatology'))) return error(res, 'Not found', 404);
    const s = await findByToken(req.params.token);
    const problem = sessionProblem(s);
    if (problem) return error(res, problem[1], problem[0], { code: 'LINK_UNUSABLE' });
    const key = req.get('X-Capture-Key') || '';
    let deviceKey = null;
    if (!s.deviceKeyHash) {
      // First phone to open the link: bind it.
      deviceKey = crypto.randomBytes(24).toString('base64url');
      await s.update({ deviceKeyHash: hashToken(deviceKey), openedAt: new Date() });
    } else if (!sameHash(hashToken(key), s.deviceKeyHash)) {
      return error(res, 'This link was already opened on another phone. Show a new QR code on the computer.', 409, { code: 'OTHER_DEVICE' });
    }
    const finding = s.DermFindingId ? await DermFinding.findByPk(s.DermFindingId, { attributes: ['id', 'number', 'title'] }) : null;
    const { current } = await consentFor([s.PatientId]);
    const p = s.Patient;
    return success(res, {
      deviceKey,                               // only on the first open — the phone keeps it
      patient: { name: patientName(p), uhid: p?.uhid, age: ageOf(p?.dateOfBirth), gender: p?.gender || null },
      purpose: s.purpose,
      regions: splitAreas(s.regions).map((id) => ({ id, label: regionLabel(id) })),
      finding: finding ? { label: `#${String(finding.number).padStart(3, '0')}`, title: finding.title } : null,
      expiresAt: s.expiresAt,
      photoCount: s.photoCount,
      consent: !!current?.clinical,
    });
  } catch (err) {
    console.error('DermCaptureSession.phoneOpen error:', err);
    return error(res, 'Server error', 500);
  }
};

// POST /api/derm-capture/:token/photos  (multipart: photo, photoType, regions; header X-Capture-Key)
const phoneUpload = async (req, res) => {
  try {
    if (!(await isModuleOn('dermatology'))) return error(res, 'Not found', 404);
    const s = await findByToken(req.params.token);
    const problem = sessionProblem(s);
    if (problem) return error(res, problem[1], problem[0], { code: 'LINK_UNUSABLE' });
    if (!s.deviceKeyHash || !sameHash(hashToken(req.get('X-Capture-Key') || ''), s.deviceKeyHash)) {
      return error(res, 'This link belongs to another phone', 409, { code: 'OTHER_DEVICE' });
    }
    // The patient as it is NOW (a merge since the QR was made moves it to the active file).
    const p = s.Patient;
    if (!p) return error(res, 'Patient not found', 404);
    const canonical = p.mergedIntoId ? await Patient.findByPk(p.mergedIntoId, { attributes: ['id', 'uhid'] }) : p;
    const family = canonical ? await resolvePatient(canonical.uhid) : null;
    if (!family || family.isDeactivated) return error(res, 'This patient file is inactive', 403);
    const { current } = await consentFor(family.patientIds);
    if (!current || !current.clinical) return error(res, 'Consent to clinical photographs is not recorded', 409, { code: 'NO_CONSENT' });

    const sessionAreas = splitAreas(s.regions);
    const areas = cleanAreas(req.body.regions, sessionAreas.length ? sessionAreas : null);
    if (!areas.ok) return error(res, areas.message, 400, { field: 'regions' });

    let finding = null;
    if (s.DermFindingId) {
      finding = await loadFinding(s.DermFindingId);
      if (finding && finding.status === 'entered_in_error') finding = null;
      if (finding) {
        const { refuse } = await familyOfFinding(finding);
        if (refuse) finding = null;
      }
      // Only the finding's own areas may be tagged on its photo.
      if (finding) {
        const own = (finding.regions || []).map((r) => r.region);
        areas.value = areas.value.filter((r) => own.includes(r));
      }
    }
    const out = await storePhoto({
      file: req.file, photoType: req.body.photoType, marker: null,
      finding, patientId: family.patient.id, areas: areas.value,
      uploadedById: s.doctorId, captureSessionId: s.id,
    });
    if (out.refuse) return error(res, out.refuse[1], out.refuse[0], out.refuse[2]);
    await s.increment('photoCount');
    return success(res, { id: out.photo.id, photoCount: s.photoCount + 1 }, 201);
  } catch (err) {
    console.error('DermCaptureSession.phoneUpload error:', err);
    return error(res, 'Server error', 500);
  }
};

// POST /api/derm-capture/:token/done — the phone is finished
const phoneDone = async (req, res) => {
  try {
    const s = await findByToken(req.params.token);
    if (!s || !s.deviceKeyHash || !sameHash(hashToken(req.get('X-Capture-Key') || ''), s.deviceKeyHash)) return error(res, 'Not found', 404);
    if (!s.closedAt) await s.update({ closedAt: new Date() });
    return success(res, { closed: true });
  } catch (err) {
    console.error('DermCaptureSession.phoneDone error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = {
  createSession, getSession, updateSession, closeSession, attachSessionToFinding,
  phoneOpen, phoneUpload, phoneDone, userName,
};
