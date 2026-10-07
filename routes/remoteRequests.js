const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { CLINICAL_READ_ROLES } = require('../constants/permissions');
const remoteRequestController = require('../controllers/remoteRequestController');

// Remote requests (6 Oct 2026). Writing one — and the prescription / lab
// request it carries — is for DOCTORS only (Emu's decision). Reading is for
// every clinical role, like the rest of the visit history. Cancelling: the
// author, checked in the controller.
router.post('/', authenticate, authorize('doctor'), remoteRequestController.create);
router.get('/', authenticate, authorize(...CLINICAL_READ_ROLES), remoteRequestController.listForPatient);
router.patch('/:id/cancel', authenticate, authorize('doctor'), remoteRequestController.cancel);

module.exports = router;
