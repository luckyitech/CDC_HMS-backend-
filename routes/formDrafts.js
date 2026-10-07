const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { INTERNAL_ROLES } = require('../constants/permissions');
const formDraftController = require('../controllers/formDraftController');

// Autosave drafts (6 Oct 2026). Every internal role may keep drafts of what
// it types — but only ever its OWN: each action is scoped to req.user.id in
// the controller, so no role (admin included) can read someone else's draft.
// Patients have no drafts.
//
// Mounted in app.js BEFORE the general (per-IP) limiter and express.json —
// see the note there. So this router parses JSON itself and limits per USER:
// 600 requests per 15 minutes per person is far above what typing produces
// (the client saves at most every few seconds, only after a pause).

const draftLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyGenerator: (req) => `draft-user-${req.user.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many draft saves — slow down a moment.' },
});

const gate = [authenticate, authorize(...INTERNAL_ROLES), draftLimiter];

router.use(express.json({ limit: '4mb' }));

// GET /api/drafts/mine — "My drafts" (no payloads)
router.get('/mine', ...gate, formDraftController.listMine);

// GET /api/drafts?uhid=…[&formKey=…&contextKey=…]
router.get('/', ...gate, formDraftController.listForPatient);

// PUT /api/drafts  { uhid, formKey, contextKey?, label?, device?, payload }
router.put('/', ...gate, formDraftController.save);

// DELETE /api/drafts?uhid=…&formKey=…[&contextKey=…]
router.delete('/', ...gate, formDraftController.remove);

// DELETE /api/drafts/:id
router.delete('/:id', ...gate, formDraftController.removeById);

module.exports = router;
