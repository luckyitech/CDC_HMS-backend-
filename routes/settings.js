const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const settings = require('../controllers/settingsController');

// System-wide settings the admin controls from the System Settings page.

// Scheduled staff password rotation — read state / flip on or off / set how
// often. Both body fields are optional; the controller rejects an empty body
// and validates the interval against the known set.
router.get('/password-rotation', authenticate, authorize('admin', 'config.write'), settings.getPasswordRotation);

// Writing is on the normal admin gate — authorize('admin', 'config.write') —
// which admits anyone holding admin.access. Decision of record (24 Sep 2026):
// full administrator access covers system settings, including this policy and
// the mailbox/comms credentials below; the settings-change audit records who.
// Noted and accepted: a clinical admin.access holder is themselves subject to
// rotation and could loosen it — a trusted full administrator, on the record.
// What stays strict is GRANTING permissions (requireTrueAdmin), which is the
// only power that must not propagate. See
// claude/session-2026-09-24-permissions-grant-decision.md.
router.put('/password-rotation', authenticate, authorize('admin', 'config.write'), [
  // toBoolean after isBoolean so the controller always sees a real boolean,
  // whether the client sent true or "true".
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('interval').optional().isString().withMessage("'interval' must be a string"),
  validate,
], settings.updatePasswordRotation);

// Lab Inbox — the clinic mailbox the labs email reports to, and the import
// policy. Read, test and write all on the normal admin gate (see the note on
// password-rotation above).
router.get('/lab-inbox', authenticate, authorize('admin', 'config.write'), settings.getLabInbox);
router.post('/lab-inbox/test', authenticate, authorize('admin', 'config.write'), settings.testLabInbox);
router.put('/lab-inbox', authenticate, authorize('admin', 'config.write'), [
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('secure').optional().isBoolean().withMessage("'secure' must be true or false").toBoolean(),
  body('allowlist').optional().isArray().withMessage("'allowlist' must be an array"),
  validate,
], settings.updateLabInbox);

// Communications Inbox — WhatsApp (Meta Cloud API) connection + behaviour +
// costs. Read, test and write all on the normal admin gate (see the note on
// password-rotation above).
router.get('/comms',       authenticate, authorize('admin', 'config.write'), settings.getComms);
router.post('/comms/test', authenticate, authorize('admin', 'config.write'), settings.testComms);
router.put('/comms', authenticate, authorize('admin', 'config.write'), [
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
