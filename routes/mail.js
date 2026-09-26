const express = require('express');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const mail = require('../controllers/mailController');

const router = express.Router();

// Staff Email (B26) — a staff member's OWN clinic mailbox, read live over IMAP.
//
// Every internal role holds email.use by role; withdrawing it stops one person
// using mail in the HMS. No route below takes a user id except the two admin
// routes at the end, which see status and can disconnect but cannot read.
const MAIL = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'email.use'];

// Testing/connecting a mailbox is a login attempt against the provider. Cap it
// per HMS user so the HMS can't be used to guess a colleague's password, and
// so a typo-loop can't get a one.com mailbox locked.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mail-login:${req.user ? req.user.id : 'anon'}`,
  message: { success: false, message: 'Too many mailbox login attempts. Wait 15 minutes and try again.' },
});

router.get('/account', authenticate, authorize(...MAIL), mail.getAccount);
router.post('/account/test', authenticate, authorize(...MAIL), loginLimiter, [
  body('emailAddress').isString().trim().notEmpty().withMessage('Enter your email address'),
  body('password').optional().isString(),
  validate,
], mail.testAccount);
router.put('/account', authenticate, authorize(...MAIL), loginLimiter, [
  body('emailAddress').isString().trim().notEmpty().withMessage('Enter your email address'),
  body('password').optional().isString(),
  body('displayName').optional().isString().isLength({ max: 120 }),
  validate,
], mail.connectAccount);
router.patch('/account', authenticate, authorize(...MAIL), [
  body('displayName').optional().isString().isLength({ max: 120 }),
  body('signatureHtml').optional().isString().isLength({ max: 5000 }),
  body('remoteImagesDefault').optional().isBoolean().toBoolean(),
  body('trustedImageSenders').optional().isArray(),
  validate,
], mail.updatePreferences);
router.delete('/account', authenticate, authorize(...MAIL), mail.disconnectAccount);

router.get('/unread', authenticate, authorize(...MAIL), mail.unread);
router.get('/folders', authenticate, authorize(...MAIL), mail.folders);
router.get('/messages', authenticate, authorize(...MAIL), mail.messages);
router.post('/messages/seen', authenticate, authorize(...MAIL), [
  body('uids').isArray({ min: 1, max: 500 }).withMessage('Pick at least one message'),
  body('seen').optional().isBoolean().toBoolean(),
  validate,
], mail.markSeen);
router.get('/messages/:uid', authenticate, authorize(...MAIL), mail.message);
router.get('/messages/:uid/attachments/:part', authenticate, authorize(...MAIL), mail.attachment);

// Admin: who is connected, and forget someone's saved password. Status only.
router.get('/admin/accounts', authenticate, authorize('admin', 'config.write'), mail.adminListAccounts);
router.post('/admin/accounts/:userId/disconnect', authenticate, authorize('admin', 'config.write'), mail.adminDisconnect);

module.exports = router;
