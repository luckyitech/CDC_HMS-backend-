const express = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { error } = require('../utils/response');
const { canViewSignins, canEditSigninSecurity, INTERNAL_ROLES } = require('../constants/permissions');
const signins = require('../controllers/signinController');

const router = express.Router();

// Sign-in records and sign-in security (16 Oct 2026, Emu) — IT and security.
//
// Deliberately NOT authorize('admin', …): authorize() admits admin.access
// holders, and where a colleague signs in from is granted person by person
// (it.signins.view / it.security.settings), like the confidential HR drawer.
// The main admin account passes as the fallback; a withdrawal always wins.
// tests/permissionVocabulary.test.js lists these under CHECKED_ELSEWHERE.
const allow = (check) => (req, res, next) => (check(req.user)
  ? next()
  : error(res, 'You do not have permission to do that — this has not been granted to your account.', 403));

const VIEW = allow(canViewSignins);
const SETTINGS = allow(canEditSigninSecurity);

// Settings first, so '/settings' is never read as an id.
router.get('/settings', authenticate, SETTINGS, signins.getSettings);
router.put('/settings', authenticate, SETTINGS, [
  body('networks').optional().isArray().withMessage('Clinic networks must be a list'),
  body('lookupEnabled').optional().isBoolean().toBoolean(),
  body('lookupProvider').optional().isString(),
  body('lookupToken').optional().isString(),
  body('gpsMode').optional().isIn(['off', 'ask']),
  body('alertsEnabled').optional().isBoolean().toBoolean(),
  body('alertChannels').optional().isObject(),
  body('rules').optional().isObject(),
  body('hours').optional().isObject(),
  body('lockOutside').optional().isBoolean().toBoolean(),
  body('lockTapExempt').optional().isBoolean().toBoolean(),
  validate,
], signins.updateSettings);

// Everyone on the staff sees their OWN sign-ins (My profile → Activity) —
// "was that me?" needs no grant. Patients are never recorded.
const STAFF_ONLY = allow((u) => INTERNAL_ROLES.includes(u?.role));
router.get('/mine', authenticate, STAFF_ONLY, signins.mine);

router.get('/', authenticate, VIEW, signins.list);
router.get('/:id', authenticate, VIEW, signins.detail);

module.exports = router;
