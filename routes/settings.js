const express = require('express');
const requireModule = require('../middleware/requireModule');
const dermProcedures = require('../controllers/dermProcedureController');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const settings = require('../controllers/settingsController');
const { INTERNAL_ROLES } = require('../constants/permissions');

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

// Two-factor sign-in — an emailed one-time code on every password login.
// Same admin gate and the same reasoning as password-rotation above; the
// settings-change audit records who turned it on or off.
//
// There is also scripts/two-factor.js, which does the same thing from the
// command line. That is on purpose: if the policy ever locks the
// administrators themselves out, the way back in must not be a screen that
// requires signing in.
router.get('/two-factor', authenticate, authorize('admin', 'config.write'), settings.getTwoFactor);
router.put('/two-factor', authenticate, authorize('admin', 'config.write'), [
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('ttlMinutes').optional().isInt().withMessage("'ttlMinutes' must be a whole number").toInt(),
  body('maxAttempts').optional().isInt().withMessage("'maxAttempts' must be a whole number").toInt(),
  validate,
], settings.updateTwoFactor);

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

// Staff Email (B26) — which domains staff may connect, each domain's mail
// servers (a provider preset or custom), extra blocked system mailboxes, and
// the feature on/off. No mailbox credential lives here — each person's is on
// their own StaffMailAccount row. Normal admin gate.
router.get('/email', authenticate, authorize('admin', 'config.write'), settings.getEmail);
router.put('/email', authenticate, authorize('admin', 'config.write'), [
  body('enabled').optional().isBoolean().withMessage("'enabled' must be true or false").toBoolean(),
  body('domains').optional().isArray().withMessage("'domains' must be a list"),
  body('blockedAddresses').optional().isArray().withMessage("'blockedAddresses' must be a list"),
  body('signature').optional().isObject().withMessage("'signature' must be an object"),
  validate,
], settings.updateEmail);

// Specialist modules (Dermatology first) — which ones this clinic has
// switched on. READ by every internal role (the consultation screen needs to
// know whether to show a module's tool); WRITE on the normal admin gate,
// logged in the settings-change trail. Off unless switched on.
router.get('/modules', authenticate, authorize(...INTERNAL_ROLES), settings.getModules);
router.put('/modules', authenticate, authorize('admin', 'config.write'), [
  body('modules').isObject().withMessage("'modules' must be an object, e.g. { dermatology: true }"),
  validate,
], settings.updateModules);

// The Dermatology procedure list (Phase 3, H8) — kept by the administrator in
// Specialist modules; logged like any setting. 404 while Dermatology is off.
// Doctors read it via GET /api/derm/procedure-list.
router.put('/derm-procedures', authenticate, authorize('admin', 'config.write'), requireModule('dermatology'), dermProcedures.putList);

module.exports = router;
