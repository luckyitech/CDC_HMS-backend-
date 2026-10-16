const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ward = require('../controllers/wardController');

// Permissions audit, 16 Oct 2026 (Emu): reaching anything inpatient follows the
// Inpatient workspace grant, not the staff role. Front desk must be granted the
// workspace (portal.inpatient) to see the board and admissions, and
// inpatient.write to act. Doctors and nurses hold the workspace by role.
const READ = ['doctor', 'nurse', 'admin', 'inpatient.access', 'portal.inpatient'];

router.get('/', authenticate, authorize(...READ), ward.listWards);
router.post('/', authenticate, authorize('admin', 'config.write'), ward.createWard);
router.put('/:id', authenticate, authorize('admin', 'config.write'), ward.updateWard);

module.exports = router;
