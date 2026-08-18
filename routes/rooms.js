const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ward = require('../controllers/wardController');

router.post('/', authenticate, authorize('admin', 'config.write'), ward.createRoom);
router.put('/:id', authenticate, authorize('admin', 'config.write'), ward.updateRoom);

module.exports = router;
