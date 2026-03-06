const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');

// ------------------------------------
// GET /api/dashboard — role-specific stats
// ------------------------------------
router.get('/', authenticate, dashboardController.getDashboard);

module.exports = router;
