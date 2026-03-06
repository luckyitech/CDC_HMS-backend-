const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const documentController = require('../controllers/documentController');

// ------------------------------------
// POST /api/documents — upload document
// ------------------------------------
router.post('/', authenticate, authorize('patient', 'doctor', 'staff'), upload.single('file'), [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('documentCategory').notEmpty().withMessage('Document category is required'),
  validate,
], documentController.upload);

// ------------------------------------
// GET /api/documents — list documents
// ------------------------------------
router.get('/', authenticate, authorize('patient', 'doctor', 'staff'), documentController.list);

// ------------------------------------
// PUT /api/documents/:id/status — review/archive document
// ------------------------------------
router.put('/:id/status', authenticate, authorize('doctor', 'staff'), [
  body('status').isIn(['Pending Review', 'Reviewed', 'Archived']).withMessage('Invalid status'),
  validate,
], documentController.updateStatus);

// ------------------------------------
// DELETE /api/documents/:id — delete document
// ------------------------------------
router.delete('/:id', authenticate, authorize('doctor', 'staff'), documentController.destroy);

// ------------------------------------
// GET /api/documents/file/:filename — serve file (authenticated)
// ------------------------------------
router.get('/file/:filename', authenticate, authorize('patient', 'doctor', 'staff'), documentController.serveFile);

module.exports = router;
