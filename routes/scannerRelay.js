const express = require('express');
const rateLimit = require('express-rate-limit');
const { scannerAuth } = require('../middleware/scannerAuth');
const hrScanner = require('../controllers/hrScannerController');

// The fingerprint-scanner relay on a clinic PC (HR Suite, 17 Oct 2026).
//
// Mounted in app.js BEFORE the general limiter, like /api/drafts: the whole
// clinic shares one public IP, and a heartbeat every minute must never eat
// into the staff's 1000-per-15-minutes. Its own JSON parser and limiter
// (a heartbeat + at most a punch batch a minute is ~30 per 15 minutes).
// Machine auth only (middleware/scannerAuth) — no JWT, no user.
const router = express.Router();

const relayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many relay requests — slow down.' },
});

router.use(relayLimiter);
router.use(express.json({ limit: '2mb' }));
router.post('/heartbeat', scannerAuth, hrScanner.heartbeat);
router.post('/punches', scannerAuth, hrScanner.punches);

module.exports = router;
