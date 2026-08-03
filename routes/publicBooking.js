const express = require('express');
const router = express.Router();
const { publicBookingLimiter } = require('../middleware/rateLimiter');
const publicBookingController = require('../controllers/publicBookingController');

// ====================================================================
// PUBLIC WEBSITE BOOKING — unauthenticated on purpose.
// The browser only ever sends a `source` key; the server decides the
// doctor. Validation, honeypot and (optional) source secret live in
// the controller. The write path is additionally rate-limited.
// ====================================================================

// GET /api/public/booking/slots?source=<publicKey>&date=YYYY-MM-DD
// Read-only availability. No patient data is ever returned.
router.get('/slots', publicBookingController.getSlots);

// POST /api/public/booking — create a scheduled appointment (+ provisional patient).
router.post('/', publicBookingLimiter, publicBookingController.book);

module.exports = router;
