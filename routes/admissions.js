const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { CLINICAL_READ_ROLES } = require('../constants/permissions');
const admission = require('../controllers/admissionController');

const READ = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];
// Acting on an admission — moving a patient in, along or out. Open to the roles
// that have always done it, OR anyone granted inpatient.write. Deliberately
// excludes /note, /request and /:id/attending: those are the doctor's clinical
// decision, not a front-desk action, and stay role-only.
const ACT = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.write'];

// Step 1 — doctor advises (from OPD consultation)
// Save & Print the admission note (documented per protocol, no billing move).
router.post('/note', authenticate, authorize('doctor'), admission.saveNote);
router.post('/request', authenticate, authorize('doctor'), admission.requestAdmission);
router.post('/cancel-request', authenticate, authorize('doctor', 'staff', 'admin', 'inpatient.write'), admission.cancelAdmissionRequest);

// Step 2 — front desk (staff) converts / direct admit
router.post('/convert', authenticate, authorize('staff', 'admin', 'inpatient.write'), admission.convert);
router.post('/direct', authenticate, authorize('staff', 'admin', 'inpatient.write'), admission.directAdmit);

// Reads
router.get('/', authenticate, authorize(...READ), admission.list);
// /advised must come before /:id so it isn't captured as an id.
// This one is uhid-scoped and feeds the patient file's Visit History, so it
// takes the wider patient-record read list (adds 'lab'). The ward-level reads
// above stay on the inpatient READ list.
router.get('/advised', authenticate, authorize(...CLINICAL_READ_ROLES, 'inpatient.access'), admission.listAdvised);
router.get('/:id', authenticate, authorize(...READ), admission.getById);

// Mutations
router.put('/:id/transfer', authenticate, authorize(...ACT), admission.transfer);
router.put('/:id/attending', authenticate, authorize('doctor', 'admin'), admission.reassignAttending);
router.put('/:id/discharge', authenticate, authorize('doctor', 'staff', 'admin', 'inpatient.write'), admission.discharge);

module.exports = router;
