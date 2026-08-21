const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');
const ward = require('../controllers/wardController');

const BOARD = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];

router.get('/board', authenticate, authorize(...BOARD), ward.board);
router.post('/', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), ward.createBed);
router.put('/:id', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), ward.updateBed);
// Porter/turnaround (nurse/staff/admin can release a cleaned bed)
router.put('/:id/release', authenticate, authorize('nurse', 'staff', 'admin', 'inpatient.write'), ward.releaseBed);

module.exports = router;
