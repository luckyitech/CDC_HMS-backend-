const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const labInbox = require('../controllers/labInboxController');

// External lab-report inbox. Operated by front-desk staff, the lab role and
// admins. Built permission-aware ('labinbox.write') so the operator set can be
// widened/narrowed later without touching routes — same two-layer pattern as
// the rest of the app (coarse gate here, specifics inline in the controller).
const OPERATE = ['staff', 'lab', 'admin', 'labinbox.write'];

// GET /api/lab-inbox?status=New — list items
router.get('/', authenticate, authorize(...OPERATE), labInbox.list);

// GET /api/lab-inbox/count — badge count of New items
router.get('/count', authenticate, authorize(...OPERATE), labInbox.count);

// GET /api/lab-inbox/:id/file — serve the staged PDF (authenticated, not static)
router.get('/:id/file', authenticate, authorize(...OPERATE), labInbox.serveFile);

// POST /api/lab-inbox/poll — manual "Pull now"
router.post('/poll', authenticate, authorize(...OPERATE), labInbox.poll);

// POST /api/lab-inbox/:id/match — pair to a patient -> creates a MedicalDocument
router.post('/:id/match', authenticate, authorize(...OPERATE), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  validate,
], labInbox.match);

// POST /api/lab-inbox/:id/discard — soft-delete a wrong pull
router.post('/:id/discard', authenticate, authorize(...OPERATE), labInbox.discard);

module.exports = router;
