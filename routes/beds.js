const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');
const ward = require('../controllers/wardController');

// Permissions audit, 16 Oct 2026 (Emu): reaching anything inpatient follows the
// Inpatient workspace grant, not the staff role. Front desk must be granted the
// workspace (portal.inpatient) to see the board and admissions, and
// inpatient.write to act. Doctors and nurses hold the workspace by role.
const BOARD = ['doctor', 'nurse', 'admin', 'inpatient.access', 'portal.inpatient'];

router.get('/board', authenticate, authorize(...BOARD), ward.board);
router.post('/', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), ward.createBed);
router.put('/:id', authenticate, authorize('admin', PERMISSIONS.ADMIN_SETUP), ward.updateBed);
// Porter/turnaround (nurse/staff/admin can release a cleaned bed)
router.put('/:id/release', authenticate, authorize('nurse', 'admin', 'inpatient.write'), ward.releaseBed);

module.exports = router;
