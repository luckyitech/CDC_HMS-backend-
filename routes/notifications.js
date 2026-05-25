const express = require('express');
const router  = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { getAll, markAsRead, markAllAsRead } = require('../controllers/notificationController');

// GET /api/notifications
router.get('/', authenticate, authorize('doctor'), getAll);

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticate, authorize('doctor'), markAllAsRead);

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticate, authorize('doctor'), markAsRead);

module.exports = router;
