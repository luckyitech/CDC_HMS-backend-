const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const admission = require('../controllers/admissionController');

const READ = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];

// Step 1 — doctor advises (from OPD consultation)
router.post('/request', authenticate, authorize('doctor'), admission.requestAdmission);
router.post('/cancel-request', authenticate, authorize('doctor', 'staff', 'admin'), admission.cancelAdmissionRequest);

// Step 2 — front desk (staff) converts / direct admit
router.post('/convert', authenticate, authorize('staff', 'admin'), admission.convert);
router.post('/direct', authenticate, authorize('staff', 'admin'), admission.directAdmit);

// Reads
router.get('/', authenticate, authorize(...READ), admission.list);
// /advised must come before /:id so it isn't captured as an id.
router.get('/advised', authenticate, authorize(...READ), admission.listAdvised);
router.get('/:id', authenticate, authorize(...READ), admission.getById);

// Mutations
router.put('/:id/transfer', authenticate, authorize('doctor', 'nurse', 'staff', 'admin'), admission.transfer);
router.put('/:id/attending', authenticate, authorize('doctor', 'admin'), admission.reassignAttending);
router.put('/:id/discharge', authenticate, authorize('doctor', 'staff', 'admin'), admission.discharge);

module.exports = router;
