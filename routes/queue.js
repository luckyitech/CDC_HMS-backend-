const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const queueController = require('../controllers/queueController');

// ------------------------------------
// GET /api/queue/stats — MUST be before /:id
// ------------------------------------
// 'nurse' reads and works the OPD queue: the nurse portal's Queue Management
// and Triage pages are the same screens the front desk uses. V3 added the role
// to every route it authored but not to these pre-existing ones, so both pages
// rendered and then 403'd.
router.get('/stats', authenticate, authorize('staff', 'doctor', 'nurse'), queueController.stats);

// ------------------------------------
// POST /api/queue/call-next — MUST be before /:id
// ------------------------------------
router.post('/call-next', authenticate, authorize('doctor'), queueController.callNext);

// ------------------------------------
// GET /api/queue — list all queue items
// ------------------------------------
router.get('/', authenticate, authorize('staff', 'doctor', 'nurse'), queueController.list);

// ------------------------------------
// GET /api/queue/advised-referrals — referral notes for one patient (Visit
// History Actions). MUST be before /:id so "advised-referrals" isn't read as an id.
// ------------------------------------
router.get('/advised-referrals', authenticate, authorize('staff', 'doctor', 'nurse'), queueController.listAdvisedReferrals);

// ------------------------------------
// GET /api/queue/patient/:uhid — a patient's visit workflow history (check-in
// and milestone timestamps). MUST be before /:id so "patient" isn't read as an id.
// ------------------------------------
router.get('/patient/:uhid', authenticate, authorize('staff', 'doctor', 'nurse', 'admin'), queueController.patientHistory);

// ------------------------------------
// POST /api/queue — add patient to queue
// ------------------------------------
router.post('/', authenticate, authorize('staff'), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  validate,
], queueController.add);

// ------------------------------------
// PUT /api/queue/:id — update status or assign doctor
// ------------------------------------
router.put('/:id', authenticate, authorize('staff', 'doctor', 'nurse'), queueController.update);

// ------------------------------------
// POST /api/queue/:id/refer — doctor refers a patient (internal or external)
// Must be defined before /:id to prevent Express matching "refer" as an ID
// ------------------------------------
router.post('/:id/refer', authenticate, authorize('doctor'), queueController.refer);

// ------------------------------------
// POST /api/queue/:id/refer-note — Save & Print the referral note (no handoff)
// Must be before /:id (DELETE) is unaffected; kept beside refer for clarity.
// ------------------------------------
router.post('/:id/refer-note', authenticate, authorize('doctor'), queueController.saveReferralNote);

// ------------------------------------
// DELETE /api/queue/:id — remove from queue
// ------------------------------------
router.delete('/:id', authenticate, authorize('staff'), queueController.remove);

module.exports = router;
