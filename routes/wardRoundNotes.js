const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const notes = require('../controllers/wardRoundNoteController');

const READ = ['doctor', 'nurse', 'admin', 'inpatient.access'];

router.post('/', authenticate, authorize('doctor'), notes.create);
router.get('/', authenticate, authorize(...READ), notes.list);
router.put('/:id', authenticate, authorize('doctor'), notes.amend);

module.exports = router;
