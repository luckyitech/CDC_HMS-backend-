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
router.post('/', authenticate, authorize('patient', 'doctor', 'staff', 'admin'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File is too large. Maximum allowed size is 25MB.' });
      }
      return res.status(400).json({ success: false, message: err.message || 'File upload failed.' });
    }
    next();
  });
}, [
  body('uhid').notEmpty().withMessage('Patient UHID is required'),
  body('documentCategory').notEmpty().withMessage('Document category is required'),
  validate,
], documentController.upload);

// ------------------------------------
// GET /api/documents — list documents
// ------------------------------------
router.get('/', authenticate, authorize('patient', 'doctor', 'staff', 'admin'), documentController.list);

// ------------------------------------
// PUT /api/documents/:id/status — review/archive document
// ------------------------------------
router.put('/:id/status', authenticate, authorize('doctor', 'staff', 'admin'), [
  body('status').isIn(['Pending Review', 'Reviewed', 'Archived']).withMessage('Invalid status'),
  validate,
], documentController.updateStatus);

// ------------------------------------
// PUT /api/documents/:id/archive — archive a wrongly uploaded document
// (hidden from all views, never deleted — medical documents must be kept)
// Admin only for now; switch to a permission check when granular roles land.
// ------------------------------------
router.put('/:id/archive', authenticate, authorize('admin'), documentController.archive);

// ------------------------------------
// PUT /api/documents/:id/restore — restore an archived document
// ------------------------------------
router.put('/:id/restore', authenticate, authorize('admin'), documentController.restore);

// ------------------------------------
// GET /api/documents/file/:filename — serve file (authenticated)
// ------------------------------------
router.get('/file/:filename', authenticate, authorize('patient', 'doctor', 'staff', 'admin'), documentController.serveFile);

module.exports = router;
