const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { INTERNAL_ROLES } = require('../constants/permissions');
const prefs = require('../controllers/userPreferenceController');

// My own display preferences (first: which Today's Consultation tools I show,
// in what order, and which open by themselves). Every internal role; always
// the caller's own rows — there is no way to read or set another person's.
router.get('/', authenticate, authorize(...INTERNAL_ROLES), prefs.list);
router.put('/:key', authenticate, authorize(...INTERNAL_ROLES), prefs.save);

module.exports = router;
