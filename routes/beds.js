const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ward = require('../controllers/wardController');

const BOARD = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];

router.get('/board', authenticate, authorize(...BOARD), ward.board);
router.post('/', authenticate, authorize('admin'), ward.createBed);
router.put('/:id', authenticate, authorize('admin'), ward.updateBed);
// Porter/turnaround (nurse/staff/admin can release a cleaned bed)
router.put('/:id/release', authenticate, authorize('nurse', 'staff', 'admin', 'inpatient.write'), ward.releaseBed);

module.exports = router;
