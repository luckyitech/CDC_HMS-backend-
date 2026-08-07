const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const ds = require('../controllers/dischargeSummaryController');

const READ = ['doctor', 'nurse', 'staff', 'admin'];

router.post('/generate', authenticate, authorize('doctor'), ds.generate);
router.post('/', authenticate, authorize('doctor'), ds.create);
router.put('/:id', authenticate, authorize('doctor'), ds.update);
router.get('/', authenticate, authorize(...READ), ds.getByAdmission);

module.exports = router;
