const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');
const logPatientAccess = require('../middleware/logPatientAccess');
const { PERMISSIONS } = require('../constants/permissions');
const histology = require('../controllers/histologyController');

// =====================================================================
// Histology / cytology — a specialist module (Phase 3, 7 Oct 2026; D11, H1)
// =====================================================================
// MODULE:  every route answers 404 while the clinic has Histology / cytology
//          switched off (System Settings → Specialist modules), after login.
// READ:    doctors and nurses by role, admins, and anyone with clinical.view.
// WRITE:   doctors by role, or anyone granted histology.record. 'admin' is
//          deliberately NOT on the write gate (admin.access runs the clinic,
//          it does not author the medical record).
// A request raises a Pending lab request (lab + billing as usual); the
// result is typed by the doctor; cancel / correct need a reason (kept).

router.use(authenticate, requireModule('histology'));

// Gates written out per route so the permission-vocabulary test can read them.
// Phase 4 (H7, V7): every request still awaiting its result, clinic-wide
// (?mine=true → mine), overdue first. Declared before /:id.
router.get('/worklist', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), histology.worklist);

// Every request for one patient (merge family); ?findingId narrows to a skin finding.
router.get('/patients/:uhid', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('histology'), histology.listForPatient);

// The patient's documents a report can be chosen from.
router.get('/patients/:uhid/documents', authorize('doctor', PERMISSIONS.HISTOLOGY_RECORD), histology.reportCandidates);

// A new histology / cytology request (+ its lab request, + optional biopsy procedure).
router.post('/patients/:uhid', authorize('doctor', PERMISSIONS.HISTOLOGY_RECORD), histology.create);

// One request with its trail.
router.get('/:id', authorize('doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW), logPatientAccess('histology'), histology.getOne);

// Record the result, or correct it (a reason after the day it was typed).
router.put('/:id/result', authorize('doctor', PERMISSIONS.HISTOLOGY_RECORD), histology.saveResult);

// Cancel a request still awaiting its result (reason required).
router.post('/:id/cancel', authorize('doctor', PERMISSIONS.HISTOLOGY_RECORD), histology.cancel);

module.exports = router;
