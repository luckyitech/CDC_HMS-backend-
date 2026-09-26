const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { error } = require('../utils/response');
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

// Phase 2 — composing. New attachments arrive as multipart `files` and are held
// in memory for this request only (never written to disk, never /uploads).
// 25 MB is the whole-message cap; mailSend re-checks the total including
// attachments carried from other messages.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20, fieldSize: 4 * 1024 * 1024 } });
const composeUpload = (req, res, next) => upload.array('files', 20)(req, res, (err) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE';
  return error(res, tooBig ? 'Attachments come to more than 25 MB. Remove some, or share large files another way.'
    : err.code === 'LIMIT_FILE_COUNT' ? 'At most 20 attachments.' : 'The attachments could not be read.', tooBig ? 413 : 400,
  { code: tooBig ? 'ATTACH_TOO_BIG' : 'BAD_UPLOAD' });
});

// one.com allows 25 messages per 5 minutes per mailbox. Stay under it so the
// HMS refuses politely before the provider does.
const sendLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mail-send:${req.user ? req.user.id : 'anon'}`,
  message: { success: false, message: 'You have sent a lot of email in the last few minutes. Wait a moment and send again — your draft is kept.', code: 'RATE_LIMITED' },
});

router.post('/send', authenticate, authorize(...MAIL), sendLimiter, composeUpload, mail.send);
router.post('/drafts', authenticate, authorize(...MAIL), composeUpload, mail.saveDraft);
router.delete('/drafts/:uid', authenticate, authorize(...MAIL), mail.discardDraft);
router.get('/messages/:uid/compose', authenticate, authorize(...MAIL), mail.composeContext);
router.get('/signature', authenticate, authorize(...MAIL), mail.signature);

// Phase 3a — HMS / patient tie-ins. Still own-mailbox only (no route takes a
// user id). Patient data is gated again inside services/mailPatients with the
// same lists as the patient and document routes.
router.get('/suggest', authenticate, authorize(...MAIL), mail.suggest);
router.get('/patients', authenticate, authorize(...MAIL), mail.patients);
router.get('/patients/:uhid/documents', authenticate, authorize(...MAIL), mail.patientDocuments);
router.post('/messages/:uid/attachments/:part/save-to-patient', authenticate, authorize(...MAIL), [
  body('uhid').isString().trim().notEmpty().withMessage('Pick a patient'),
  body('category').optional().isString().isLength({ max: 80 }),
  body('testDate').optional({ values: 'falsy' }).isString(),
  body('notes').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
  validate,
], mail.saveToPatient);

// Admin: who is connected, and forget someone's saved password. Status only.
router.get('/admin/accounts', authenticate, authorize('admin', 'config.write'), mail.adminListAccounts);
router.post('/admin/accounts/:userId/disconnect', authenticate, authorize('admin', 'config.write'), mail.adminDisconnect);

module.exports = router;
