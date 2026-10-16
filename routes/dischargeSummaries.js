const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ds = require('../controllers/dischargeSummaryController');

// Permissions audit, 16 Oct 2026 (Emu): reaching anything inpatient follows the
// Inpatient workspace grant, not the staff role. Front desk must be granted the
// workspace (portal.inpatient) to see the board and admissions, and
// inpatient.write to act. Doctors and nurses hold the workspace by role.
const READ = ['doctor', 'nurse', 'admin', 'inpatient.access', 'portal.inpatient'];

router.post('/generate', authenticate, authorize('doctor'), ds.generate);
router.post('/', authenticate, authorize('doctor'), ds.create);
router.put('/:id', authenticate, authorize('doctor'), ds.update);
router.get('/', authenticate, authorize(...READ), ds.getByAdmission);

module.exports = router;
