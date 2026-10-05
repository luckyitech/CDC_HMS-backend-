const express = require('express');
const router = express.Router();
const { param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireTrueAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/permissionPresetController');
const { canEditPermissions, passesGate } = require('../constants/permissions');
const { error } = require('../utils/response');

// Permission presets — see controllers/permissionPresetController.js.
//
// Reads: anyone who can view users (the onboarding wizard lists them).
// Writes: requireTrueAdmin (= canGrantPermissions — a permissions.grant holder
// or the true admin fallback). Defining a bundle of grants is a grant decision,
// so it sits behind the same gate as granting; no new capability.

const ID = [param('id').isInt({ min: 1 }).withMessage('Invalid preset id'), validate];

// Reading the list: the wizard's readers, plus whoever may edit someone's
// permissions — "Apply preset…" on the Permissions tab (5 Oct 2026, HR fixes
// #22), where an HR grantor may hold neither users.view nor staff.onboard.
const READERS = ['admin', 'users.view', 'staff.onboard'];
const presetReader = (req, res, next) => {
  if (passesGate(req.user, READERS) || canEditPermissions(req.user)) return next();
  return error(res, 'Access denied', 403);
};

router.get('/',            authenticate, presetReader, ctrl.list);
router.post('/',           authenticate, requireTrueAdmin, ctrl.create);
router.put('/:id',         authenticate, requireTrueAdmin, ID, ctrl.update);
router.patch('/:id/archive', authenticate, requireTrueAdmin, ID, ctrl.archive);
router.patch('/:id/restore', authenticate, requireTrueAdmin, ID, ctrl.restore);

module.exports = router;
