const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { getAll, markAsRead, markAllAsRead } = require('../controllers/notificationController');

// The bell. Doctors have had it since the document notifications; since B27
// every member of staff gets HR alerts in it (leave to approve, decisions,
// expiries), so every internal role reads its OWN notifications here.
// notificationController.bellScope decides which rows each person sees.
const BELL = ['doctor', 'staff', 'nurse', 'lab', 'admin'];

// GET /api/notifications
router.get('/', authenticate, authorize(...BELL), getAll);

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticate, authorize(...BELL), markAllAsRead);

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticate, authorize(...BELL), markAsRead);

module.exports = router;
