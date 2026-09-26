const crypto = require('crypto');
const accounts = require('./mailAccounts');
const session = require('./mailSession');
const { checkAddress, getSignatureConfig, logoDataUri } = require('../utils/mailConfig');
const { walkParts } = require('../utils/mailRender');
const {
  MAX_RECIPIENTS, parseRecipients, recipientSummary, prefixSubject, replyRecipients,
  threadHeaders, parseIdList, quoteOriginal, htmlToText, outgoingHtml, splitDraftHtml, joinBody, signatureBlock,
} = require('../utils/mailCompose');

const { MailError } = session;

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 2 — sending, replying, forwarding and drafts.
//
// Same live-proxy rules as reading: nothing is stored in the HMS. Uploaded
// attachments live in memory for the length of one request (multer
// memoryStorage) and are gone when it ends. Attachments carried from another
// message (a forward, or a draft being continued) are read from the user's own
// mailbox at send time.
//
//   send       → SMTP (the user's own login) → IMAP APPEND a copy to Sent.
//                SMTP does not keep a copy by itself. If the APPEND fails
//                (full mailbox) the message HAS gone: we say so and never
//                resend.
//   drafts     → IMAP APPEND to Drafts (\Draft), replacing the previous
//                version. Discard moves the draft to Trash (one.com has no
//                backups — nothing the user wrote is destroyed outright).
//
// Every function acts on the caller's own mailbox; there is no way to name
// another person's (decision D1).
// ---------------------------------------------------------------------------

const MAX_TOTAL_ATTACH = 25 * 1024 * 1024;   // one.com allows 70 MB/message; base64 adds ~33%
const MAX_ATTACHMENTS = 20;
const MODES = ['reply', 'replyAll', 'forward'];

/** The caller's usable account + servers + password, or a MailError. */
const loadAccount = async (userId) => {
  const row = await accounts.findForUser(userId);
  if (!row || row.status === 'disconnected' || !row.passwordEncrypted) {
    throw new MailError('NOT_CONNECTED', 'Your mailbox is not connected.', 409);
  }
  if (row.status === 'needs_password') {
    throw new MailError('NEEDS_PASSWORD', row.lastError || 'Enter your mailbox password again to reconnect.', 409);
  }
  const check = await checkAddress(row.emailAddress);
  if (!check.ok) throw new MailError('NOT_ALLOWED', check.reason, 403);
  return { row, servers: check.servers, password: accounts.passwordFor(row) };
};

const fromHeader = (row, fallbackName) => ({
  name: (row.displayName || fallbackName || '').replace(/[\r\n"]/g, ' ').trim(),
  address: row.emailAddress,
});

const cleanSubject = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);

/**
 * Validate a composer payload's recipients. `requireOne` for send (a draft
 * may have none yet).
 */
const recipientsFrom = (payload, requireOne) => {
  const to = parseRecipients(payload.to || []);
  const cc = parseRecipients(payload.cc || []);
  const bcc = parseRecipients(payload.bcc || []);
  const bad = [...to.bad, ...cc.bad, ...bcc.bad];
  if (bad.length) {
    throw new MailError('BAD_RECIPIENT', `Check ${bad.length === 1 ? 'this address' : 'these addresses'}: ${bad.slice(0, 5).join(', ')}`, 400);
  }
  const total = to.ok.length + cc.ok.length + bcc.ok.length;
  if (requireOne && !total) throw new MailError('NO_RECIPIENT', 'Add at least one recipient.', 400);
  if (total > MAX_RECIPIENTS) throw new MailError('TOO_MANY_RECIPIENTS', `A message can go to at most ${MAX_RECIPIENTS} people.`, 400);
  return { to: to.ok, cc: cc.ok, bcc: bcc.ok };
};

const cleanRefs = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_ATTACHMENTS).map((r) => ({
  folder: String((r && r.folder) || ''),
  uid: parseInt(r && r.uid, 10),
  part: String((r && r.part) || ''),
})).filter((r) => r.folder && r.uid > 0 && /^[0-9]+(\.[0-9]+)*$/.test(r.part));

/**
 * The attachments for one outgoing message: files uploaded in this request
 * plus parts carried from messages in the user's own mailbox. Carried parts
 * are re-read from the server and must really be attachments of that message.
 */
const gatherAttachments = async (userId, refs, files) => {
  const out = [];
  let total = 0;
  const add = (att) => {
    total += att.content.length;
    if (total > MAX_TOTAL_ATTACH) {
      throw new MailError('ATTACH_TOO_BIG', 'Attachments come to more than 25 MB. Remove some, or share large files another way.', 413);
    }
    out.push(att);
  };

  // Group carried parts by folder so each folder is locked once.
  const byFolder = new Map();
  for (const r of cleanRefs(refs)) {
    if (!byFolder.has(r.folder)) byFolder.set(r.folder, []);
    byFolder.get(r.folder).push(r);
  }
  for (const [folder, list] of byFolder.entries()) {
    await session.withFolder(userId, folder, async (client) => {
      const structures = new Map();
      for (const r of list) {
        if (!structures.has(r.uid)) {
          const msg = await client.fetchOne(String(r.uid), { uid: true, bodyStructure: true }, { uid: true });
          if (!msg) throw new MailError('ATTACH_GONE', 'An attachment\'s original message is no longer in your mailbox. Remove it and attach the file again.', 409);
          structures.set(r.uid, walkParts(msg.bodyStructure).attachments);
        }
        const meta = structures.get(r.uid).find((a) => a.part === r.part);
        if (!meta) throw new MailError('ATTACH_GONE', 'An attachment is no longer on its original message. Remove it and attach the file again.', 409);
        const content = await session.downloadPart(client, r.uid, r.part, MAX_TOTAL_ATTACH + 1);
        add({ filename: meta.filename, contentType: meta.type || 'application/octet-stream', content });
      }
    });
  }

  for (const f of (files || []).slice(0, MAX_ATTACHMENTS)) {
    add({
      filename: String(f.originalname || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 200),
      contentType: f.mimetype || 'application/octet-stream',
      content: f.buffer,
    });
  }
  if (out.length > MAX_ATTACHMENTS) throw new MailError('TOO_MANY_ATTACHMENTS', `At most ${MAX_ATTACHMENTS} attachments.`, 400);
  return out;
};

/** Build the RFC 822 message. `keepBcc` for the Sent/Drafts copy only — never for SMTP. */
const buildRaw = ({ from, rcpt, subject, html, inReplyTo, references, attachments, messageId, date, keepBcc, draft }) => {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const headers = { 'X-Mailer': 'CDC HMS' };
  if (draft) headers['X-HMS-Draft'] = '1';
  const mail = new MailComposer({
    from,
    to: rcpt.to,
    cc: rcpt.cc,
    bcc: rcpt.bcc,
    subject,
    html: outgoingHtml(html),
    text: htmlToText(html),
    inReplyTo: inReplyTo || undefined,
    references: references && references.length ? references : undefined,
    attachments,
    messageId,
    date,
    headers,
  }).compile();
  mail.keepBcc = !!keepBcc;
  return new Promise((resolve, reject) => mail.build((err, buf) => (err ? reject(err) : resolve(buf))));
};

const newMessageId = (address) => `<${crypto.randomUUID()}@${String(address).split('@')[1] || 'hms.local'}>`;

/** The threading headers the composer carries, validated. */
const threadFrom = (payload) => {
  const inReplyTo = parseIdList(payload.inReplyTo)[0] || null;
  const references = parseIdList(Array.isArray(payload.references) ? payload.references.join(' ') : payload.references).slice(-20);
  return { inReplyTo, references };
};

const isSmtpAuthError = (err) => !!(err && (err.code === 'EAUTH' || err.responseCode === 535));

/**
 * APPEND a copy to a special folder. Returns { ok, uid, path, reason }. Never
 * throws — the caller decides what a failure means.
 */
const appendTo = async (userId, key, raw, flags) => {
  try {
    const path = await session.specialFolder(userId, key);
    if (!path) return { ok: false, reason: 'no_folder' };
    const client = await session.getClient(userId);
    const res = await client.append(path, raw, flags);
    return { ok: true, uid: res && res.uid ? res.uid : null, path };
  } catch (err) {
    const text = `${err.responseText || ''} ${err.message || ''}`;
    return { ok: false, reason: /quota|over ?quota|mailbox is full|limit/i.test(text) ? 'full' : 'failed' };
  }
};

/** Find a just-appended message by Message-ID when the server didn't return a UID (no UIDPLUS). */
const uidByMessageId = async (userId, folder, messageId) => session.withFolder(userId, folder, async (client) => {
  const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
  return uids && uids.length ? Math.max(...uids) : null;
});

/** A draft in the Drafts folder — only a message carrying \Draft may be replaced or discarded. */
const withOwnDraft = async (userId, uid, fn) => {
  const drafts = await session.specialFolder(userId, 'drafts');
  if (!drafts) throw new MailError('NO_DRAFTS', 'Your mailbox has no Drafts folder.', 409);
  const id = session.cleanUid(uid);
  return session.withFolder(userId, drafts, async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, flags: true }, { uid: true });
    if (!msg) return fn(client, null, drafts);
    if (!(msg.flags && msg.flags.has('\\Draft'))) throw new MailError('NOT_A_DRAFT', 'That message is not a draft.', 400);
    return fn(client, id, drafts);
  });
};

/** Drop the previous version of a draft once its replacement is safely saved. */
const removeDraftVersion = async (userId, uid) => {
  try {
    await withOwnDraft(userId, uid, async (client, id) => {
      if (id) await client.messageDelete(String(id), { uid: true });
    });
  } catch (err) {
    console.error('[Mail] old draft cleanup failed:', err.code || err.message);
  }
};

/** Mark the original \Answered (reply) or $Forwarded (forward). Best effort. */
const flagOriginal = async (userId, source) => {
  if (!source || !MODES.includes(source.mode)) return;
  try {
    const uid = session.cleanUid(source.uid);
    await session.withFolder(userId, String(source.folder || 'INBOX'), (client) => client.messageFlagsAdd(
      String(uid), [source.mode === 'forward' ? '$Forwarded' : '\\Answered'], { uid: true },
    ));
  } catch { /* the reply went; a missing flag is cosmetic */ }
};

/**
 * Send. payload: { to, cc, bcc, subject, html, inReplyTo, references,
 * attachments: [{ folder, uid, part }], draftUid?, source?: { mode, folder, uid } }.
 */
const send = async (userId, payload = {}, files = [], { senderName } = {}) => {
  const { row, servers, password } = await loadAccount(userId);
  const rcpt = recipientsFrom(payload, true);
  const subject = cleanSubject(payload.subject);
  const { inReplyTo, references } = threadFrom(payload);
  const attachments = await gatherAttachments(userId, payload.attachments, files);
  const from = fromHeader(row, senderName);
  const messageId = newMessageId(row.emailAddress);
  const date = new Date();
  // The signature is added here, on send — never stored in drafts — so it is
  // on every message whatever the composer did, and never doubled.
  const clinic = await getSignatureConfig();
  const logoCid = `clinic-logo.${crypto.randomUUID()}@hms`;
  const signature = signatureBlock({ personalHtml: row.signatureHtml, clinic, logoSrc: clinic.logo ? `cid:${logoCid}` : null });
  const withLogo = signature && clinic.logo
    ? [...attachments, { filename: clinic.logo.type === 'image/jpeg' ? 'logo.jpg' : 'logo.png', content: clinic.logo.buffer, contentType: clinic.logo.type, cid: logoCid, contentDisposition: 'inline' }]
    : attachments;
  const html = joinBody(`${String(payload.html || '')}${signature}`, payload.quotedHtml);
  const base = { from, rcpt, subject, html, inReplyTo, references, attachments: withLogo, messageId, date };

  const forSmtp = await buildRaw({ ...base, keepBcc: false });
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: servers.smtp.host,
    port: servers.smtp.port,
    secure: !!servers.smtp.secure,
    auth: { user: row.emailAddress, pass: password },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
  try {
    await transport.sendMail({
      envelope: { from: row.emailAddress, to: [...rcpt.to, ...rcpt.cc, ...rcpt.bcc].map((r) => r.address) },
      raw: forSmtp,
    });
  } catch (err) {
    if (isSmtpAuthError(err)) {
      const parked = await accounts.recordAuthFailure(row, 'SMTP login refused');
      throw new MailError(parked ? 'NEEDS_PASSWORD' : 'AUTH',
        parked ? 'Your mailbox refused the saved password (it may have been changed). Enter it again to reconnect.'
          : 'The mail server refused the login. Try again in a moment.', 409);
    }
    // one.com's own reason (a limit, a refused recipient) is the most useful thing to show.
    const reason = String(err.response || err.message || 'the mail server refused it').replace(/[\r\n]+/g, ' ').slice(0, 300);
    console.error('[Mail] send failed:', err.code || 'error', err.responseCode || '');
    throw new MailError('SEND_FAILED', `Not sent: ${reason}`, 502);
  } finally {
    transport.close();
  }

  // It has gone. Everything after this point must never cause a resend.
  const summary = recipientSummary([rcpt.to, rcpt.cc, rcpt.bcc]);
  accounts.logEvent({
    userId, actorId: userId, event: 'sent', emailAddress: row.emailAddress,
    detail: JSON.stringify({ recipients: summary.count, domains: summary.domains, attachments: attachments.length }),
  });

  let sentCopy = { ok: false, reason: 'failed' };
  try {
    const forSent = await buildRaw({ ...base, keepBcc: true });
    sentCopy = await appendTo(userId, 'sent', forSent, ['\\Seen']);
  } catch (err) {
    console.error('[Mail] sent copy failed:', err.code || err.message);
  }

  const draftUid = parseInt(payload.draftUid, 10);
  let draftKept = false;
  if (draftUid > 0) {
    if (sentCopy.ok) await removeDraftVersion(userId, draftUid);
    else draftKept = true;   // no copy in Sent — the draft is the only record the user has
  }
  await flagOriginal(userId, payload.source);

  return {
    sent: true,
    messageId,
    sentCopy: sentCopy.ok,
    sentCopyReason: sentCopy.ok ? null : sentCopy.reason,
    draftKept,
  };
};

/** The signature as it will appear, with the logo as a data: URI — for the Composer and settings previews. */
const signaturePreview = async (userId) => {
  const row = await accounts.findForUser(userId);
  const clinic = await getSignatureConfig();
  return { html: signatureBlock({ personalHtml: row ? row.signatureHtml : '', clinic, logoSrc: logoDataUri(clinic) }) };
};

/** The attachment parts of a saved draft, as refs the composer can carry forward. */
const draftAttachmentRefs = async (userId, folder, uid) => session.withFolder(userId, folder, async (client) => {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!msg) return [];
  return walkParts(msg.bodyStructure).attachments.map((a) => ({
    folder, uid, part: a.part, filename: a.filename, type: a.type, size: a.size,
  }));
});

/**
 * Save (or replace) a draft. Returns { draftUid, folder, attachments } — the
 * attachments now live in the draft, so the composer swaps its uploaded files
 * for these refs and never uploads them again.
 */
const saveDraft = async (userId, payload = {}, files = [], { senderName } = {}) => {
  const { row } = await loadAccount(userId);
  const rcpt = recipientsFrom(payload, false);
  const { inReplyTo, references } = threadFrom(payload);
  const attachments = await gatherAttachments(userId, payload.attachments, files);
  const messageId = newMessageId(row.emailAddress);
  const raw = await buildRaw({
    from: fromHeader(row, senderName), rcpt, subject: cleanSubject(payload.subject), html: joinBody(payload.html, payload.quotedHtml),
    inReplyTo, references, attachments, messageId, date: new Date(), keepBcc: true, draft: true,
  });

  const saved = await appendTo(userId, 'drafts', raw, ['\\Draft', '\\Seen']);
  if (!saved.ok) {
    throw new MailError(saved.reason === 'full' ? 'MAILBOX_FULL' : saved.reason === 'no_folder' ? 'NO_DRAFTS' : 'DRAFT_FAILED',
      saved.reason === 'full' ? 'Draft not saved: your mailbox is full.'
        : saved.reason === 'no_folder' ? 'Your mailbox has no Drafts folder.' : 'Draft not saved. Try again in a moment.', 502);
  }
  const uid = saved.uid || await uidByMessageId(userId, saved.path, messageId);

  const previous = parseInt(payload.draftUid, 10);
  if (previous > 0 && previous !== uid) await removeDraftVersion(userId, previous);

  return {
    draftUid: uid,
    folder: saved.path,
    attachments: uid ? await draftAttachmentRefs(userId, saved.path, uid) : [],
    savedAt: new Date().toISOString(),
  };
};

/** Discard a draft: move it to Trash (never destroyed outright — one.com keeps no backups). */
const discardDraft = async (userId, uid) => {
  const trash = await session.specialFolder(userId, 'trash');
  return withOwnDraft(userId, uid, async (client, id) => {
    if (!id) return { discarded: false };
    if (trash) await client.messageMove(String(id), trash, { uid: true });
    else await client.messageFlagsAdd(String(id), ['\\Deleted'], { uid: true });
    return { discarded: true, movedTo: trash || null };
  });
};

/**
 * What the composer opens with, built from a message in the user's mailbox.
 *   mode reply | replyAll | forward — a new message answering/forwarding it
 *   mode draft                      — continue a saved draft as it was
 */
const composeContext = async (userId, { folder = 'INBOX', uid, mode }) => {
  if (![...MODES, 'draft'].includes(mode)) throw new MailError('BAD_MODE', 'Unknown compose mode.', 400);
  const { row } = await loadAccount(userId);
  const msg = await session.getMessage(userId, { folder, uid, markSeen: false });

  if (mode === 'draft') {
    if (!msg.draft) throw new MailError('NOT_A_DRAFT', 'That message is not a draft.', 400);
    const { body, quote } = splitDraftHtml(msg.html);
    return {
      mode,
      to: msg.to, cc: msg.cc, bcc: msg.bcc,
      subject: msg.subject || '',
      html: body,
      quotedHtml: quote,
      inReplyTo: parseIdList(msg.inReplyTo)[0] || null,
      references: parseIdList(msg.references),
      attachments: msg.attachments.map((a) => ({ folder: msg.folder, uid: msg.uid, part: a.part, filename: a.filename, type: a.type, size: a.size })),
      draftUid: msg.uid,
      source: null,
    };
  }

  const { to, cc } = replyRecipients(msg, mode, row.emailAddress);
  const thread = mode === 'forward' ? { inReplyTo: null, references: [] } : threadHeaders({ messageId: msg.messageId, references: msg.references });
  return {
    mode,
    to, cc, bcc: [],
    subject: prefixSubject(msg.subject, mode),
    html: '',
    quotedHtml: quoteOriginal(msg, mode),
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    // A forward carries the original's attachments (the user can remove any).
    attachments: mode === 'forward'
      ? msg.attachments.map((a) => ({ folder: msg.folder, uid: msg.uid, part: a.part, filename: a.filename, type: a.type, size: a.size }))
      : [],
    draftUid: null,
    source: { mode, folder: msg.folder, uid: msg.uid },
  };
};

module.exports = {
  MAX_TOTAL_ATTACH,
  MAX_ATTACHMENTS,
  send,
  saveDraft,
  discardDraft,
  composeContext,
  signaturePreview,
  _internals: { buildRaw, recipientsFrom, cleanRefs },
};
