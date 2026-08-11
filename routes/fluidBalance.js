const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const fb = require('../controllers/fluidBalanceController');

const READ = ['doctor', 'nurse', 'admin', 'inpatient.access'];

router.post('/', authenticate, authorize('nurse', 'doctor'), fb.create);
router.get('/', authenticate, authorize(...READ), fb.list);

module.exports = router;
