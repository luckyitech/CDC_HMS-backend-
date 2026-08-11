const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ward = require('../controllers/wardController');

const READ = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];

router.get('/', authenticate, authorize(...READ), ward.listWards);
router.post('/', authenticate, authorize('admin'), ward.createWard);
router.put('/:id', authenticate, authorize('admin'), ward.updateWard);

module.exports = router;
