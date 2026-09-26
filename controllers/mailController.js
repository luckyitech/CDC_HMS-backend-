const db = require('../models');
const { success, error } = require('../utils/response');
const accounts = require('../services/mailAccounts');
const session = require('../services/mailSession');
const mailSend = require('../services/mailSend');
const { checkAddress, getMailConfig, normEmail } = require('../utils/mailConfig');

// ===========================================================================
// Staff Email (B26) — /api/mail. Phase 1: connect + read. Phase 2: send,
// reply, forward, drafts.
//
// EVERY handler here acts on req.user.id's OWN mailbox. There is no route
// parameter that selects a user, so nobody — administrators included — can
// open another person's mail through the HMS (decision D1). The two /admin
// handlers at the bottom see connection STATUS only and can disconnect; they
// can't read.
//
// Nothing read from a mailbox is stored. See services/mailSession.js.
// ===========================================================================

const sendMailError = (res, err, fallback) => {
  if (err instanceof session.MailError) return error(res, err.message, err.status, { code: err.code });
  console.error(`${fallback} error:`, err.message);
  return error(res, 'Something went wrong reading your mailbox. Try again in a moment.', 500);
};

/**
 * GET /api/mail/account
 * The caller's connection (redacted) + what the setup card needs: whether the
 * clinic has email set up, the allowed domains, and a suggested address (the
 * HMS login email, when it is on an allowed domain and not a system mailbox).
 */
const getAccount = async (req, res) => {
  try {
    const [row, cfg, user] = await Promise.all([
      accounts.findForUser(req.user.id),
      getMailConfig(),
      db.User.findByPk(req.user.id, { attributes: ['email', 'firstName', 'lastName'] }),
    ]);
    const hmsEmail = normEmail(user && user.email);
    const suggestion = hmsEmail && (await checkAddress(hmsEmail)).ok ? hmsEmail : '';
    return success(res, {
      account: accounts.redact(row),
      setup: {
        enabled: cfg.enabled,
        configured: cfg.domains.length > 0,
        domains: cfg.domains.map((d) => d.domain),
        suggestedAddress: suggestion,
        suggestedName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
      },
    });
  } catch (err) {
    console.error('StaffMailAccount.getAccount error:', err.message);
    return error(res, 'Failed to load your email settings', 500);
  }
};

const passwordForTest = async (userId, emailAddress, password) => {
  if (password) return password;
  const row = await accounts.findForUser(userId);
  if (row && row.passwordEncrypted && row.emailAddress === normEmail(emailAddress)) return accounts.passwordFor(row);
  return null;
};

/**
 * POST /api/mail/account/test  { emailAddress, password? }
 * Tries the login without saving. A refused test is written to the audit
 * (metadata only) so repeated guessing at a colleague's mailbox is visible.
 */
const testAccount = async (req, res) => {
  try {
    const emailAddress = normEmail(req.body.emailAddress);
    const check = await checkAddress(emailAddress);
    if (!check.ok) return error(res, check.reason, 400, { code: check.code });
    const password = await passwordForTest(req.user.id, emailAddress, req.body.password);
    if (!password) return error(res, 'Enter your mailbox password.', 400, { code: 'PASSWORD_REQUIRED' });
    try {
      const result = await session.testLogin({ emailAddress, password, servers: check.servers });
      return success(res, result);
    } catch (err) {
      if (err.code === 'AUTH') {
        accounts.logEvent({ userId: req.user.id, actorId: req.user.id, event: 'auth_failed', emailAddress, detail: 'test' });
      }
      throw err;
    }
  } catch (err) {
    return sendMailError(res, err, 'StaffMailAccount.testAccount');
  }
};

/**
 * PUT /api/mail/account  { emailAddress, password, displayName? }
 * Connect (or reconnect after a password change). Saves ONLY after a
 * successful login, so a typo never parks a broken credential.
 */
const connectAccount = async (req, res) => {
  try {
    const emailAddress = normEmail(req.body.emailAddress);
    const check = await checkAddress(emailAddress);
    if (!check.ok) return error(res, check.reason, 400, { code: check.code });
    if (await accounts.addressInUseByOther(emailAddress, req.user.id)) {
      return error(res, 'That mailbox is already connected to another HMS account.', 409, { code: 'IN_USE' });
    }
    const password = await passwordForTest(req.user.id, emailAddress, req.body.password);
    if (!password) return error(res, 'Enter your mailbox password.', 400, { code: 'PASSWORD_REQUIRED' });

    try {
      await session.testLogin({ emailAddress, password, servers: check.servers });
    } catch (err) {
      if (err.code === 'AUTH') {
        accounts.logEvent({ userId: req.user.id, actorId: req.user.id, event: 'auth_failed', emailAddress, detail: 'connect' });
      }
      throw err;
    }

    session.closeClient(req.user.id);   // drop any connection made with the old credential
    const row = await accounts.saveConnection({
      userId: req.user.id,
      emailAddress,
      password,
      provider: check.servers.provider,
      displayName: req.body.displayName,
    });
    return success(res, { account: accounts.redact(row) });
  } catch (err) {
    return sendMailError(res, err, 'StaffMailAccount.connectAccount');
  }
};

/** PATCH /api/mail/account  { displayName?, signatureHtml?, remoteImagesDefault?, trustedImageSenders? } */
const updatePreferences = async (req, res) => {
  try {
    const row = await accounts.updatePreferences(req.user.id, req.body || {});
    if (!row) return error(res, 'Connect your mailbox first.', 409, { code: 'NOT_CONNECTED' });
    return success(res, { account: accounts.redact(row) });
  } catch (err) {
    console.error('StaffMailAccount.updatePreferences error:', err.message);
    return error(res, 'Failed to save your email settings', 500);
  }
};

/** DELETE /api/mail/account — forget the password; mail on the server is untouched. */
const disconnectAccount = async (req, res) => {
  try {
    await accounts.wipe({ userId: req.user.id, actorId: req.user.id, reason: 'disconnected' });
    return success(res, { account: accounts.redact(await accounts.findForUser(req.user.id)) });
  } catch (err) {
    console.error('StaffMailAccount.disconnectAccount error:', err.message);
    return error(res, 'Failed to disconnect your mailbox', 500);
  }
};

/** GET /api/mail/unread — { connected, status, unread, canSetUp } for the badge + nudge. Never 500s. */
const unread = async (req, res) => {
  try {
    const [state, cfg] = await Promise.all([session.unreadCount(req.user.id), getMailConfig()]);
    // canSetUp lets the one-time "connect your email" nudge stay quiet in a
    // clinic that hasn't set email up yet.
    return success(res, { ...state, canSetUp: cfg.enabled && cfg.domains.length > 0 });
  } catch (err) {
    console.error('StaffMailAccount.unread error:', err.message);
    return success(res, { connected: false, status: 'error', unread: 0 });
  }
};

/** GET /api/mail/folders */
const folders = async (req, res) => {
  try {
    return success(res, { folders: await session.listFolders(req.user.id) });
  } catch (err) {
    return sendMailError(res, err, 'Mail.folders');
  }
};

/** GET /api/mail/messages?folder=&page=&pageSize=&q= */
const messages = async (req, res) => {
  try {
    const { folder, page, pageSize, q } = req.query;
    return success(res, await session.listMessages(req.user.id, { folder, page, pageSize, q }));
  } catch (err) {
    return sendMailError(res, err, 'Mail.messages');
  }
};

/** GET /api/mail/messages/:uid?folder=&peek=1 — opening marks it read unless peek. */
const message = async (req, res) => {
  try {
    return success(res, await session.getMessage(req.user.id, {
      folder: req.query.folder, uid: req.params.uid, markSeen: req.query.peek !== '1',
    }));
  } catch (err) {
    return sendMailError(res, err, 'Mail.message');
  }
};

/** GET /api/mail/messages/:uid/attachments/:part?folder= — streamed, never stored. */
const attachment = async (req, res) => {
  try {
    await session.streamAttachment(req.user.id, { folder: req.query.folder, uid: req.params.uid, part: req.params.part }, res);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return undefined; }
    return sendMailError(res, err, 'Mail.attachment');
  }
  return undefined;
};

/** POST /api/mail/messages/seen  { folder, uids: [], seen: true|false } */
const markSeen = async (req, res) => {
  try {
    const { folder, uids, seen } = req.body || {};
    return success(res, await session.setSeen(req.user.id, { folder, uids, seen: seen !== false }));
  } catch (err) {
    return sendMailError(res, err, 'Mail.markSeen');
  }
};

// ---------------------------------------------------------------------------
// Phase 2 — send, reply, forward, drafts. The composer posts multipart:
// a `message` field (JSON) plus any new `files`. Files stay in memory for this
// request only.
// ---------------------------------------------------------------------------

const readPayload = (req) => {
  const raw = req.body && req.body.message;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { throw new session.MailError('BAD_PAYLOAD', 'The message could not be read. Try again.', 400); }
};

const senderNameFor = async (userId) => {
  const u = await db.User.findByPk(userId, { attributes: ['firstName', 'lastName'] });
  return u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
};

/** POST /api/mail/send  (multipart: message=JSON, files[]) */
const send = async (req, res) => {
  try {
    const payload = readPayload(req);
    const result = await mailSend.send(req.user.id, payload, req.files || [], { senderName: await senderNameFor(req.user.id) });
    return success(res, result);
  } catch (err) {
    return sendMailError(res, err, 'Mail.send');
  }
};

/** POST /api/mail/drafts  (multipart: message=JSON incl. draftUid to replace, files[]) */
const saveDraft = async (req, res) => {
  try {
    const payload = readPayload(req);
    const result = await mailSend.saveDraft(req.user.id, payload, req.files || [], { senderName: await senderNameFor(req.user.id) });
    return success(res, result);
  } catch (err) {
    return sendMailError(res, err, 'Mail.saveDraft');
  }
};

/** DELETE /api/mail/drafts/:uid — moves the draft to Trash. */
const discardDraft = async (req, res) => {
  try {
    return success(res, await mailSend.discardDraft(req.user.id, req.params.uid));
  } catch (err) {
    return sendMailError(res, err, 'Mail.discardDraft');
  }
};

/** GET /api/mail/signature — { html } the signature added to every message, for previews. */
const signature = async (req, res) => {
  try {
    return success(res, await mailSend.signaturePreview(req.user.id));
  } catch (err) {
    console.error('Mail.signature error:', err.message);
    return error(res, 'Failed to load your signature', 500);
  }
};

/** GET /api/mail/messages/:uid/compose?folder=&mode=reply|replyAll|forward|draft */
const composeContext = async (req, res) => {
  try {
    return success(res, await mailSend.composeContext(req.user.id, {
      folder: req.query.folder, uid: req.params.uid, mode: req.query.mode,
    }));
  } catch (err) {
    return sendMailError(res, err, 'Mail.composeContext');
  }
};

// ---------------------------------------------------------------------------
// Admin — status and disconnect only. No route here can read a mailbox.
// ---------------------------------------------------------------------------

/** GET /api/mail/admin/accounts */
const adminListAccounts = async (req, res) => {
  try {
    return success(res, { accounts: await accounts.listForAdmin() });
  } catch (err) {
    console.error('StaffMailAccount.adminListAccounts error:', err.message);
    return error(res, 'Failed to load connected mailboxes', 500);
  }
};

/** POST /api/mail/admin/accounts/:userId/disconnect — forget a person's saved password. */
const adminDisconnect = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!(userId > 0)) return error(res, 'Unknown user', 400);
    const done = await accounts.wipe({ userId, actorId: req.user.id, reason: 'admin_disconnected' });
    if (!done) return error(res, 'That person has no connected mailbox', 404);
    return success(res, { userId, disconnected: true });
  } catch (err) {
    console.error('StaffMailAccount.adminDisconnect error:', err.message);
    return error(res, 'Failed to disconnect that mailbox', 500);
  }
};

module.exports = {
  getAccount,
  testAccount,
  connectAccount,
  updatePreferences,
  disconnectAccount,
  unread,
  folders,
  messages,
  message,
  attachment,
  markSeen,
  send,
  saveDraft,
  discardDraft,
  composeContext,
  signature,
  adminListAccounts,
  adminDisconnect,
};
