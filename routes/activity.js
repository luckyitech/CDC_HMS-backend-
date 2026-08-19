const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { getActivityLog } = require('../controllers/activityController');

// GET /api/activity — admin only
router.get('/', authenticate, authorize('admin', 'monitoring.view'), getActivityLog);

module.exports = router;
