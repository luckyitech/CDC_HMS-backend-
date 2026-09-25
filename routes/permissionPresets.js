const express = require('express');
const router = express.Router();
const { param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireTrueAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/permissionPresetController');

// Permission presets — see controllers/permissionPresetController.js.
//
// Reads: anyone who can view users (the onboarding wizard lists them).
// Writes: requireTrueAdmin (= canGrantPermissions — a permissions.grant holder
// or the true admin fallback). Defining a bundle of grants is a grant decision,
// so it sits behind the same gate as granting; no new capability.

const ID = [param('id').isInt({ min: 1 }).withMessage('Invalid preset id'), validate];

router.get('/',            authenticate, authorize('admin', 'users.view'), ctrl.list);
router.post('/',           authenticate, requireTrueAdmin, ctrl.create);
router.put('/:id',         authenticate, requireTrueAdmin, ID, ctrl.update);
router.patch('/:id/archive', authenticate, requireTrueAdmin, ID, ctrl.archive);
router.patch('/:id/restore', authenticate, requireTrueAdmin, ID, ctrl.restore);

module.exports = router;
