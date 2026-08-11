const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const staffDocumentController = require('../controllers/staffDocumentController');

// Staff documents are sensitive HR records — admin only on every route.

// ------------------------------------
// POST /api/staff-documents — upload a staff document
// ------------------------------------
router.post('/', authenticate, authorize('admin'), (req, res, next) => {
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
  body('staffUserId').notEmpty().withMessage('Staff member is required'),
  validate,
], staffDocumentController.upload);

// ------------------------------------
// GET /api/staff-documents?staffUserId= — list a staff member's documents
// ------------------------------------
router.get('/', authenticate, authorize('admin'), staffDocumentController.list);

// ------------------------------------
// PUT /api/staff-documents/:id/archive — soft-delete a document
// ------------------------------------
router.put('/:id/archive', authenticate, authorize('admin'), staffDocumentController.archive);

// ------------------------------------
// PUT /api/staff-documents/:id/restore — restore an archived document
// ------------------------------------
router.put('/:id/restore', authenticate, authorize('admin'), staffDocumentController.restore);

// ------------------------------------
// GET /api/staff-documents/file/:filename — serve file (authenticated, admin)
// ------------------------------------
router.get('/file/:filename', authenticate, authorize('admin'), staffDocumentController.serveFile);

module.exports = router;
