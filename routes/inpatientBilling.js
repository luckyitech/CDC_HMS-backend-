const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const billing = require('../controllers/inpatientBillingController');

const READ = ['staff', 'admin', 'doctor', 'inpatient.access'];

router.get('/', authenticate, authorize(...READ), billing.getAccount);
router.post('/', authenticate, authorize('staff', 'admin', 'inpatient.write'), billing.addCharge);
router.post('/accrue-beddays', authenticate, authorize('staff', 'admin', 'inpatient.write'), billing.accrue);

module.exports = router;
