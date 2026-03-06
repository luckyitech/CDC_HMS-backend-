const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const queueController = require('../controllers/queueController');

// ------------------------------------
// GET /api/queue/stats — MUST be before /:id
// ------------------------------------
router.get('/stats', authenticate, authorize('staff', 'doctor'), queueController.stats);

// ------------------------------------
// POST /api/queue/call-next — MUST be before /:id
// ------------------------------------
router.post('/call-next', authenticate, authorize('doctor'), queueController.callNext);

// ------------------------------------
// GET /api/queue — list all queue items
// ------------------------------------
router.get('/', authenticate, authorize('staff', 'doctor'), queueController.list);

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
router.put('/:id', authenticate, authorize('staff', 'doctor'), queueController.update);

// ------------------------------------
// DELETE /api/queue/:id — remove from queue
// ------------------------------------
router.delete('/:id', authenticate, authorize('staff'), queueController.remove);

module.exports = router;
