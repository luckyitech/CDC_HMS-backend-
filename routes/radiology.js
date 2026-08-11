const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const rad = require('../controllers/radiologyController');

const READ = ['doctor', 'nurse', 'admin', 'lab'];

router.post('/', authenticate, authorize('doctor'), rad.create);
router.get('/', authenticate, authorize(...READ), rad.list);
// Reporting: radiographer role arrives with RBAC; for now lab/admin can report.
router.put('/:id/report', authenticate, authorize('lab', 'admin'), rad.report);

module.exports = router;
