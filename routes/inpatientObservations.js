const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const obs = require('../controllers/inpatientObservationController');

const READ = ['doctor', 'nurse', 'admin', 'inpatient.access'];

router.post('/', authenticate, authorize('nurse', 'doctor'), obs.create);
router.get('/', authenticate, authorize(...READ), obs.list);
router.put('/:id', authenticate, authorize('nurse', 'doctor'), obs.amend);

module.exports = router;
