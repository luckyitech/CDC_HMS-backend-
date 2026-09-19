const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const labInbox = require('../controllers/labInboxController');

// External lab-report inbox. Front desk and the lab hold both capabilities by
// role; a doctor or nurse can be granted them; either can be withdrawn from
// anyone on the Permissions tab. Two-layer as everywhere else: the coarse gate
// here, specifics (merge rule, already-paired, etc.) inline in the controller.
const VIEW  = ['staff', 'lab', 'admin', 'labinbox.view'];
const WRITE = ['staff', 'lab', 'admin', 'labinbox.write'];

// GET /api/lab-inbox?status=New — list items
router.get('/', authenticate, authorize(...VIEW), labInbox.list);

// GET /api/lab-inbox/count — badge count of New items + sync status
router.get('/count', authenticate, authorize(...VIEW), labInbox.count);

// GET /api/lab-inbox/:id/file — serve the staged PDF (authenticated, not static)
router.get('/:id/file', authenticate, authorize(...VIEW), labInbox.serveFile);

// POST /api/lab-inbox/poll — manual "Pull now"
router.post('/poll', authenticate, authorize(...WRITE), labInbox.poll);

// POST /api/lab-inbox/:id/match — pair to a patient -> creates a MedicalDocument
router.post('/:id/match', authenticate, authorize(...WRITE), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  validate,
], labInbox.match);

// POST /api/lab-inbox/:id/discard — soft-delete a wrong pull
router.post('/:id/discard', authenticate, authorize(...WRITE), labInbox.discard);

module.exports = router;
