const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const billing = require('../controllers/inpatientBillingController');

// Permissions audit, 16 Oct 2026 (Emu): reaching anything inpatient follows the
// Inpatient workspace grant, not the staff role. Front desk must be granted the
// workspace (portal.inpatient) to see the board and admissions, and
// inpatient.write to act. Doctors and nurses hold the workspace by role.
const READ = ['admin', 'doctor', 'inpatient.access', 'portal.inpatient'];

router.get('/', authenticate, authorize(...READ), billing.getAccount);
router.post('/', authenticate, authorize('admin', 'inpatient.write'), billing.addCharge);
router.post('/accrue-beddays', authenticate, authorize('admin', 'inpatient.write'), billing.accrue);

module.exports = router;
