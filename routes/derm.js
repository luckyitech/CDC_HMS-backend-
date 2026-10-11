const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');
const logPatientAccess = require('../middleware/logPatientAccess');
const { PERMISSIONS } = require('../constants/permissions');
const derm = require('../controllers/dermController');
const photos = require('../controllers/dermPhotoController');
const procedures = require('../controllers/dermProcedureController');
const capture = require('../controllers/dermCaptureController');
const skinExam = require('../controllers/dermSkinExamController');
const { handleDermPhotoUpload } = require('../middleware/uploadDermPhoto');

// =====================================================================
// Dermatology — the skin record (specialist module, 7 Oct 2026)
// =====================================================================
// MODULE:  every route answers 404 while the clinic has Dermatology switched
//          off (System Settings → Specialist modules). Checked after login so
//          an anonymous caller learns nothing either way.
// READ:    doctors and nurses by role, admins, and anyone with clinical.view.
// WRITE:   doctors by role, or anyone granted derm.record. 'admin' is
//          deliberately NOT on the write gate, so admin.access (running the
//          clinic) does not confer authoring a clinical record. The true
//          admin account holds every capability, as everywhere else.
// Writes carry their own rules in the controller: same-day author edits,
// otherwise a reason (amend); never a hard delete (entered in error).

router.use(authenticate, requireModule('dermatology'));

// Gates are written out on every route (not shared constants) so the
// permission-vocabulary test can read them.
// The case board for one patient (merge family).
// Names typed for "Other" before (no patient data — just the clinic's words).
router.get('/vocabulary', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), derm.vocabulary);
router.get('/patients/:uhid/findings', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('dermatology'), derm.listFindings);

// ---- Phase 4: every skin visit, as recorded that day (Visit History, the
// generated note, "All skin visits"). ?date=YYYY-MM-DD → one day. Photo
// metadata only for doctor / derm.record; counts for everyone else.
router.get('/patients/:uhid/visits', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('dermatology'), derm.skinVisits);

// A new finding with today's first look.
router.post('/patients/:uhid/findings', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.createFinding);

// One finding with its full timeline and amendment trail.
router.get('/findings/:id', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('dermatology'), derm.getFinding);

// Change what / where a finding is (reason unless the creator, same day).
router.put('/findings/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.updateFinding);

// Record or correct today's look at a finding.
router.put('/findings/:id/today', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.saveToday);

// Mark a finding entered in error (reason required; never deleted).
router.post('/findings/:id/entered-in-error', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.findingInError);

// Amend an earlier look (reason required; kept in the trail).
router.put('/observations/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.amendObservation);

// Mark one look entered in error (reason required).
router.post('/observations/:id/entered-in-error', authorize('doctor', PERMISSIONS.DERM_RECORD), derm.observationInError);

// ---- Today's whole-skin exam (9 Oct 2026): hair, nails, lymph nodes, mucosa —
// one per patient per clinic day. Read like the record; written like a look.
router.get('/patients/:uhid/skin-exam', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('dermatology'), skinExam.getSkinExam);
router.put('/patients/:uhid/skin-exam', authorize('doctor', PERMISSIONS.DERM_RECORD), skinExam.saveSkinExam);
router.put('/skin-exams/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), skinExam.amendSkinExam);

// ---- Phase 2: photography consent and skin photos ----
// Consent: read like the rest of the record; recorded by those who may write.
router.get('/patients/:uhid/consent', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), photos.getConsent);
router.post('/patients/:uhid/consent', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.recordConsent);

// Photos — PICTURES are for doctors (or derm.record) only, never the wider
// clinical.view audience (decision D3: nurses read the record, not the photos).
router.get('/patients/:uhid/photos', authorize('doctor', PERMISSIONS.DERM_RECORD), logPatientAccess('dermatology-photos'), photos.listPhotos);
// Area photos (no finding yet) and filing them under a finding later (8 Oct 2026).
router.post('/patients/:uhid/photos', authorize('doctor', PERMISSIONS.DERM_RECORD), handleDermPhotoUpload, photos.uploadAreaPhoto);
router.put('/photos/:id/link', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.linkPhoto);
// Phone hand-off: the computer makes a one-time QR link and watches photos arrive.
router.post('/patients/:uhid/capture', authorize('doctor', PERMISSIONS.DERM_RECORD), capture.createSession);
router.get('/capture/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), capture.getSession);
router.put('/capture/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), capture.updateSession);
router.post('/capture/:id/close', authorize('doctor', PERMISSIONS.DERM_RECORD), capture.closeSession);
router.post('/findings/:id/photos', authorize('doctor', PERMISSIONS.DERM_RECORD), handleDermPhotoUpload, photos.uploadPhoto);
router.get('/photos/:id/file', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.sendPhotoFile);
router.get('/photos/:id/views', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.photoViews);
router.put('/photos/:id/marker', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.setMarker);
router.post('/photos/:id/entered-in-error', authorize('doctor', PERMISSIONS.DERM_RECORD), photos.photoInError);

// ---- Phase 3: procedures (recorded, not billed — H8) ----
// The clinic's procedure list: read here by anyone who reads the record. It is
// KEPT by the administrator in System Settings (PUT /api/settings/derm-procedures
// — configuration, not the medical record, so it is not on this file's
// doctor / derm.record write gate).
router.get('/procedure-list', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW, 'config.write'), procedures.getList);
router.get('/patients/:uhid/procedures', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('dermatology'), procedures.listForPatient);
router.post('/patients/:uhid/procedures', authorize('doctor', PERMISSIONS.DERM_RECORD), procedures.create);
router.put('/procedures/:id', authorize('doctor', PERMISSIONS.DERM_RECORD), procedures.update);
router.post('/procedures/:id/entered-in-error', authorize('doctor', PERMISSIONS.DERM_RECORD), procedures.enteredInError);

module.exports = router;
