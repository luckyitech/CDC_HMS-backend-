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

// Lab Inbox — the clinic mailbox the labs email reports to, and the import
// policy. Read/test with the normal admin gate; WRITING credentials is held to
// a real admin account, like the password policy above.
router.get('/lab-inbox', authenticate, authorize('admin', 'config.write'), settings.getLabInbox);
router.post('/lab-inbox/test', authenticate, authorize('admin', 'config.write'), settings.testLabInbox);
router.put('/lab-inbox', authenticate, requireTrueAdmin, [
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('secure').optional().isBoolean().withMessage("'secure' must be true or false").toBoolean(),
  body('allowlist').optional().isArray().withMessage("'allowlist' must be an array"),
  validate,
], settings.updateLabInbox);

// Communications Inbox — WhatsApp (Meta Cloud API) connection + behaviour +
// costs. Reading/testing uses the normal admin gate; WRITING the credentials is
// held to a real admin account, like the mailbox and the password policy.
router.get('/comms',       authenticate, authorize('admin', 'config.write'), settings.getComms);
router.post('/comms/test', authenticate, authorize('admin', 'config.write'), settings.testComms);
router.put('/comms', authenticate, requireTrueAdmin, [
  body('autoLink').optional().isBoolean().toBoolean(),
  body('markReadOnOpen').optional().isBoolean().toBoolean(),
  body('warnNoConsent').optional().isBoolean().toBoolean(),
  validate,
], settings.updateComms);
router.put('/comms/costs', authenticate, authorize('admin', 'config.write'), [
  body('rateCard').optional().isArray().withMessage("'rateCard' must be an array"),
  validate,
], settings.updateCommsCosts);

module.exports = router;
