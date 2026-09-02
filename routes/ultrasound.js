const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');
const ingestAuth = require('../middleware/ingestAuth');
const uploadUltrasound = require('../middleware/uploadUltrasound');
const us = require('../controllers/ultrasoundController');
const bridge = require('../controllers/bridgeController');

// HMIS V4 — ultrasound imaging (HS70A → DICOM bridge → here).
const READ = ['doctor', 'nurse', 'admin'];

// ------------------------------------
// POST /api/ultrasound/ingest — bridge upload (machine auth, no JWT)
// ------------------------------------
router.post('/ingest', ingestAuth, (req, res, next) => {
  uploadUltrasound.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File is too large. Maximum allowed size is 30MB.' });
      }
      return res.status(400).json({ success: false, message: err.message || 'File upload failed.' });
    }
    next();
  });
}, us.ingest);

// ------------------------------------
// DICOM bridge control — status chip + Restart button in the Radiology Suite.
//   heartbeat: machine auth (the bridge polls this and gets any pending restart
//              back in the response); status/restart: JWT, any radiology user.
// ------------------------------------
const BRIDGE_USERS = ['doctor', 'nurse', 'staff', 'admin', PERMISSIONS.RADIOLOGY_WRITE];
router.post('/bridge/heartbeat', ingestAuth, bridge.heartbeat);
router.get('/bridge/status',  authenticate, authorize(...BRIDGE_USERS), bridge.status);
router.post('/bridge/restart', authenticate, authorize(...BRIDGE_USERS), bridge.requestRestart);

// ------------------------------------
// GET /api/ultrasound — list (uhid=... | unassigned=1)
// ------------------------------------
router.get('/', authenticate, authorize(...READ), us.list);

// ------------------------------------
// GET /api/ultrasound/studies — Ultrasound Studio worklist (grouped)
// ------------------------------------
router.get('/studies', authenticate, authorize(...READ), us.studies);

// ------------------------------------
// GET /api/ultrasound/file/:filename — serve image (authenticated)
// ------------------------------------
router.get('/file/:filename', authenticate, authorize(...READ), us.serveFile);

// ------------------------------------
// PUT /api/ultrasound/inbox-dismiss — explicitly remove images from the inbox list
// ------------------------------------
router.put('/inbox-dismiss', authenticate, authorize(...READ), us.dismissInbox);

// ------------------------------------
// POST /api/ultrasound/edited — save a clinician-edited still into a patient's
// image safe (JWT-authed; reporting tech or clinician). Multipart 'file' + uhid.
// ------------------------------------
router.post('/edited', authenticate, authorize('doctor', 'nurse', 'admin', PERMISSIONS.RADIOLOGY_WRITE), (req, res, next) => {
  uploadUltrasound.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Image upload failed.' });
    next();
  });
}, us.saveEdited);

// ------------------------------------
// PUT /api/ultrasound/:id/assign — link image to a patient
// ------------------------------------
router.put('/:id/assign', authenticate, authorize(...READ), us.assign);

// ------------------------------------
// PUT /api/ultrasound/:id/archive — admin soft-delete (never hard-delete)
// ------------------------------------
router.put('/:id/archive', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), us.archive);

module.exports = router;
