const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize, requireTrueAdmin } = require('../middleware/auth');
const settings = require('../controllers/settingsController');

// System-wide settings the admin controls from the System Settings page.

// Scheduled staff password rotation — read state / flip on or off / set how
// often. Both body fields are optional; the controller rejects an empty body
// and validates the interval against the known set.
router.get('/password-rotation', authenticate, authorize('admin', 'config.write'), settings.getPasswordRotation);

// Writing is restricted to a REAL admin account. authorize('admin', 'config.write') also admits
// anyone holding admin.access — and those users are clinical staff who are
// themselves subject to rotation, so that would let someone switch off the
// policy that binds them. Same reasoning as permission-granting: see
// middleware/auth.js requireTrueAdmin.
router.put('/password-rotation', authenticate, requireTrueAdmin, [
  // toBoolean after isBoolean so the controller always sees a real boolean,
  // whether the client sent true or "true".
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('interval').optional().isString().withMessage("'interval' must be a string"),
  validate,
], settings.updatePasswordRotation);

module.exports = router;
