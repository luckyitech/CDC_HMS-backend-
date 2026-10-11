const express = require('express');
const rateLimit = require('express-rate-limit');
const capture = require('../controllers/dermCaptureController');
const { handleDermPhotoUpload } = require('../middleware/uploadDermPhoto');

// The phone side of a skin-photo hand-off (8 Oct 2026). NO sign-in: the
// one-time token in the QR link is the key, bound to the first phone that
// opens it (X-Capture-Key). It can only add photos to the patient, areas and
// finding the doctor chose on the computer — never read the record.
// See controllers/dermCaptureController.js.
const router = express.Router();

// Per token (the whole clinic shares one public IP, so not per IP): a lost QR
// cannot be hammered. The general per-IP limiter still applies in front.
const phoneLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `derm-capture:${String(req.params.token || '').slice(0, 64)}`,
  message: { success: false, message: 'Too many requests — wait a minute and try again.' },
});

router.get('/:token', phoneLimiter, capture.phoneOpen);
router.post('/:token/photos', phoneLimiter, handleDermPhotoUpload, capture.phoneUpload);
router.post('/:token/done', phoneLimiter, capture.phoneDone);

module.exports = router;
