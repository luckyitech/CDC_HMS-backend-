const accounts = require('./mailAccounts');
const { checkAddress, getMailConfig } = require('../utils/mailConfig');
const {
  walkParts, hasAttachments, sanitizeHtml, textToHtml, hasRemoteContent,
  inlineCids, addressList, isExternal, shapeFolders,
} = require('../utils/mailRender');

// ---------------------------------------------------------------------------
// Staff Email (B26) — the live IMAP layer (the "live proxy").
//
// Each staff member's mailbox is reached with THEIR credential, one ImapFlow
// connection per user, reused across requests and closed after 5 idle
// minutes. Nothing read here is persisted: folders, messages and attachments
// stream from the provider to the browser and are gone.
//
// Every public function takes the caller's userId and nothing else that
// selects a mailbox. There is no way to name another person's account — that
// is the whole of decision D1, enforced by the shape of this module.
//
// Login refusals: two in a row park the account in needs_password
// (services/mailAccounts.recordAuthFailure) and no further attempts are made
// until the user re-enters the password — repeated failures can lock a
// one.com mailbox.
// ---------------------------------------------------------------------------

class MailError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;          // HTML/text part read into memory
const MAX_INLINE_IMAGE_BYTES = 1.5 * 1024 * 1024; // per cid: image embedded as data:
const MAX_INLINE_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 75 * 1024 * 1024;    // one.com's own cap is 70 MB per message
const PAGE_SIZE_MAX = 100;

const pool = new Map(); // userId -> { client?, connecting?, lastUsed }
let sweeper = null;

const isAuthError = (err) => !!(err && (
  err.authenticationFailed
  || err.serverResponseCode === 'AUTHENTICATIONFAILED'
  || /AUTHENTICATIONFAILED|invalid credentials|authentication failed|login failed/i.test(`${err.responseText || ''} ${err.message || ''}`)
));

const isConnectionGone = (err) => !!(err && (
  err.code === 'NoConnection' || err.code === 'EConnectionClosed' || err.code === 'ECONNRESET' || err.code === 'EPIPE'
  || /connection not available|connection closed/i.test(err.message || '')
));

const openImap = async ({ imap, user, pass }) => {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: !!imap.secure,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
  });
  await client.connect();
  return client;
};

const startSweeper = () => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of pool.entries()) {
      if (entry.client && now - entry.lastUsed > IDLE_CLOSE_MS) closeClient(userId);
    }
  }, 60 * 1000);
  if (sweeper.unref) sweeper.unref();
};

/** Close and forget a user's connection (disconnect, wipe, idle). Never throws. */
function closeClient(userId) {
  const entry = pool.get(userId);
  pool.delete(userId);
  if (entry && entry.client) entry.client.logout().catch(() => {});
}

/**
 * Try a login with these credentials without saving anything. Used by the
 * setup card and by connect (which only saves after this succeeds).
 */
const testLogin = async ({ emailAddress, password, servers }) => {
  let client;
  try {
    client = await openImap({ imap: servers.imap, user: emailAddress, pass: password });
    const status = await client.status('INBOX', { messages: true, unseen: true });
    return { ok: true, messages: status.messages, unseen: status.unseen };
  } catch (err) {
    if (isAuthError(err)) throw new MailError('AUTH', 'The mailbox refused that email and password. Check the password you use for webmail.', 400);
    throw new MailError('UNREACHABLE', `Couldn't reach the mail server (${err.code || 'connection failed'}). Try again in a moment.`, 502);
  } finally {
    if (client) await client.logout().catch(() => {});
  }
};

/** The caller's live connection — opened on demand, shared by parallel requests. */
const getClient = async (userId) => {
  startSweeper();
  const entry = pool.get(userId);
  if (entry && entry.client && entry.client.usable) { entry.lastUsed = Date.now(); return entry.client; }
  if (entry && entry.connecting) return entry.connecting;
  if (entry) closeClient(userId);

  const connecting = (async () => {
    const row = await accounts.findForUser(userId);
    if (!row || row.status === 'disconnected' || !row.passwordEncrypted) {
      throw new MailError('NOT_CONNECTED', 'Your mailbox is not connected.', 409);
    }
    if (row.status === 'needs_password') {
      throw new MailError('NEEDS_PASSWORD', row.lastError || 'Enter your mailbox password again to reconnect.', 409);
    }
    const check = await checkAddress(row.emailAddress);
    if (!check.ok) throw new MailError('NOT_ALLOWED', check.reason, 403);

    let client;
    try {
      client = await openImap({ imap: check.servers.imap, user: row.emailAddress, pass: accounts.passwordFor(row) });
    } catch (err) {
      if (isAuthError(err)) {
        const parked = await accounts.recordAuthFailure(row, err.responseText || err.message);
        throw new MailError(parked ? 'NEEDS_PASSWORD' : 'AUTH',
          parked ? 'Your mailbox refused the saved password (it may have been changed). Enter it again to reconnect.'
            : 'Your mailbox refused the login just now. Try again in a moment.', 409);
      }
      await accounts.recordConnectionError(row, err.code || err.message);
      throw new MailError('UNREACHABLE', 'Couldn\'t reach your mail server. Try again in a moment.', 502);
    }
    client.on('close', () => { const e = pool.get(userId); if (e && e.client === client) pool.delete(userId); });
    // Log the error class only — never an address, subject or credential.
    client.on('error', (err) => console.error('[Mail] connection error:', err.code || err.message));
    await accounts.markConnected(row);
    pool.set(userId, { client, lastUsed: Date.now() });
    return client;
  })();

  pool.set(userId, { connecting, lastUsed: Date.now() });
  try {
    return await connecting;
  } catch (err) {
    const e = pool.get(userId);
    if (e && e.connecting === connecting) pool.delete(userId);
    throw err;
  }
};

const cleanFolder = (folder) => {
  const f = String(folder || 'INBOX');
  if (!f.trim() || f.length > 300) throw new MailError('BAD_FOLDER', 'Unknown folder.', 400);
  return f;
};

/**
 * Run fn(client) with `folder` selected. One retry if the pooled connection
 * died underneath us (server timeout, network blip).
 */
const withFolder = async (userId, folder, fn, attempt = 0) => {
  const client = await getClient(userId);
  let lock;
  try {
    lock = await client.getMailboxLock(cleanFolder(folder));
  } catch (err) {
    if (attempt === 0 && isConnectionGone(err)) { closeClient(userId); return withFolder(userId, folder, fn, 1); }
    if (err instanceof MailError) throw err;
    throw new MailError('NOT_FOUND', 'That folder no longer exists.', 404);
  }
  try {
    const result = await fn(client);
    const entry = pool.get(userId);
    if (entry) entry.lastUsed = Date.now();
    return result;
  } catch (err) {
    if (attempt === 0 && isConnectionGone(err)) { lock.release(); lock = null; closeClient(userId); return withFolder(userId, folder, fn, 1); }
    throw err;
  } finally {
    if (lock) lock.release();
  }
};

const streamToBuffer = (stream, max) => new Promise((resolve, reject) => {
  const chunks = []; let bytes = 0;
  stream.on('data', (c) => {
    bytes += c.length;
    if (bytes > max) { stream.destroy(); resolve(Buffer.concat(chunks)); return; }
    chunks.push(c);
  });
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

const readPart = async (client, uid, part, max) => {
  const { content } = await client.download(String(uid), part, { uid: true, maxBytes: max });
  if (!content) return Buffer.alloc(0);
  return streamToBuffer(content, max).catch(() => Buffer.alloc(0));
};

const allowedDomains = async () => (await getMailConfig()).domains.map((d) => d.domain);

// ---------------------------------------------------------------------------
// Operations — each acts on the caller's own mailbox only.
// ---------------------------------------------------------------------------

const listFolders = async (userId) => {
  const client = await getClient(userId);
  const rows = await client.list({ statusQuery: { messages: true, unseen: true } });
  return shapeFolders(rows);
};

const toListItem = (msg, domains) => {
  const flags = msg.flags || new Set();
  const env = msg.envelope || {};
  const from = addressList(env.from)[0] || null;
  return {
    uid: msg.uid,
    subject: env.subject || '',
    from,
    to: addressList(env.to),
    date: env.date || msg.internalDate || null,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    size: msg.size || 0,
    external: from ? isExternal(from.address, domains) : false,
  };
};

const LIST_QUERY = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true };

const listMessages = async (userId, { folder = 'INBOX', page = 1, pageSize = 50, q = '' } = {}) => {
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), PAGE_SIZE_MAX);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const query = String(q || '').trim().slice(0, 200);
  const domains = await allowedDomains();

  return withFolder(userId, folder, async (client) => {
    let total; let fetched = [];
    if (query) {
      const uids = ((await client.search({ text: query }, { uid: true })) || []).sort((a, b) => b - a);
      total = uids.length;
      const pageUids = uids.slice((p - 1) * size, p * size);
      if (pageUids.length) fetched = await client.fetchAll(pageUids.join(','), LIST_QUERY, { uid: true });
    } else {
      total = client.mailbox.exists || 0;
      const end = total - (p - 1) * size;
      if (end >= 1) {
        const start = Math.max(1, end - size + 1);
        fetched = await client.fetchAll(`${start}:${end}`, LIST_QUERY);
      }
    }
    // Newest ARRIVAL first — the same order the pages are cut in (sequence /
    // UID), which is how mail apps list a folder. Sorting a page by the
    // sender's Date header instead would disagree with the paging and let a
    // back-dated message jump pages.
    const messages = fetched.map((m) => toListItem(m, domains)).sort((a, b) => b.uid - a.uid);
    return { folder: client.mailbox.path, total, page: p, pageSize: size, messages };
  });
};

const cleanUid = (uid) => {
  const n = parseInt(uid, 10);
  if (!(n > 0)) throw new MailError('BAD_UID', 'Unknown message.', 400);
  return n;
};

const getMessage = async (userId, { folder = 'INBOX', uid, markSeen = true } = {}) => {
  const id = cleanUid(uid);
  const domains = await allowedDomains();
  return withFolder(userId, folder, async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, { uid: true });
    if (!msg) throw new MailError('NOT_FOUND', 'That message is no longer in this folder.', 404);
    const parts = walkParts(msg.bodyStructure);

    let body = '';
    let isHtml = false;
    if (parts.html) {
      body = sanitizeHtml((await readPart(client, id, parts.html.part, MAX_BODY_BYTES)).toString('utf8'));
      isHtml = true;
    } else if (parts.text) {
      body = textToHtml((await readPart(client, id, parts.text.part, MAX_BODY_BYTES)).toString('utf8'));
    }

    // Images the HTML references by Content-ID, embedded as data: URIs so the
    // sandboxed frame never has to fetch anything to show them.
    if (isHtml && parts.inline.length) {
      const map = {}; let total = 0;
      for (const img of parts.inline) {
        if (!img.contentId || img.size > MAX_INLINE_IMAGE_BYTES * 1.4 || total > MAX_INLINE_TOTAL_BYTES) continue;
        const buf = await readPart(client, id, img.part, MAX_INLINE_IMAGE_BYTES);
        if (!buf.length) continue;
        total += buf.length;
        map[img.contentId] = `data:${img.type};base64,${buf.toString('base64')}`;
      }
      body = inlineCids(body, map);
    }

    const flags = msg.flags || new Set();
    let seen = flags.has('\\Seen');
    if (markSeen && !seen) {
      await client.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
      seen = true;
    }

    const env = msg.envelope || {};
    const from = addressList(env.from)[0] || null;
    return {
      uid: id,
      folder: client.mailbox.path,
      subject: env.subject || '',
      from,
      to: addressList(env.to),
      cc: addressList(env.cc),
      replyTo: addressList(env.replyTo),
      date: env.date || msg.internalDate || null,
      messageId: env.messageId || null,
      seen,
      flagged: flags.has('\\Flagged'),
      isHtml,
      html: body,
      hasRemoteContent: isHtml && hasRemoteContent(body),
      external: from ? isExternal(from.address, domains) : false,
      attachments: parts.attachments.map((a) => ({ part: a.part, filename: a.filename, type: a.type, size: a.size })),
    };
  });
};

/** A safe header filename: ASCII fallback + RFC 5987 UTF-8 form. */
const dispositionHeader = (filename) => {
  const name = String(filename || 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/**
 * Stream one attachment to the response. The folder lock is held until the
 * stream finishes, then released. Always sent as a download (never rendered
 * on the API origin); the browser previews PDFs/images from a blob.
 */
const streamAttachment = async (userId, { folder = 'INBOX', uid, part }, res) => {
  const id = cleanUid(uid);
  const partId = String(part || '');
  if (!/^[0-9]+(\.[0-9]+)*$/.test(partId)) throw new MailError('BAD_PART', 'Unknown attachment.', 400);

  const client = await getClient(userId);
  let lock;
  try {
    lock = await client.getMailboxLock(cleanFolder(folder));
  } catch {
    throw new MailError('NOT_FOUND', 'That folder no longer exists.', 404);
  }
  let released = false;
  const release = () => { if (!released) { released = true; lock.release(); } };
  try {
    const msg = await client.fetchOne(String(id), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) throw new MailError('NOT_FOUND', 'That message is no longer in this folder.', 404);
    const parts = walkParts(msg.bodyStructure);
    const meta = [...parts.attachments, ...parts.inline].find((a) => a.part === partId);
    if (!meta) throw new MailError('NOT_FOUND', 'That attachment is not on this message.', 404);

    const { content } = await client.download(String(id), partId, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES });
    if (!content) throw new MailError('NOT_FOUND', 'That attachment could not be read.', 404);

    res.setHeader('Content-Type', meta.type || 'application/octet-stream');
    res.setHeader('Content-Disposition', dispositionHeader(meta.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    content.on('end', release);
    content.on('error', (err) => { release(); console.error('[Mail] attachment stream error:', err.code || err.message); res.destroy(); });
    res.on('close', () => { content.destroy(); release(); });
    content.pipe(res);
  } catch (err) {
    release();
    throw err;
  }
};

const setSeen = async (userId, { folder = 'INBOX', uids = [], seen = true } = {}) => {
  const list = [...new Set((Array.isArray(uids) ? uids : []).map((u) => parseInt(u, 10)).filter((n) => n > 0))].slice(0, 500);
  if (!list.length) throw new MailError('BAD_UID', 'Pick at least one message.', 400);
  return withFolder(userId, folder, async (client) => {
    if (seen) await client.messageFlagsAdd(list.join(','), ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove(list.join(','), ['\\Seen'], { uid: true });
    return { folder: client.mailbox.path, uids: list, seen: !!seen };
  });
};

/**
 * Unread count for the badge. Never opens a connection for someone who isn't
 * connected, and never throws — a badge must not break a page.
 */
const unreadCount = async (userId) => {
  const row = await accounts.findForUser(userId);
  if (!row || row.status === 'disconnected' || !row.passwordEncrypted) return { connected: false, status: row ? row.status : 'none', unread: 0 };
  if (row.status === 'needs_password') return { connected: false, status: 'needs_password', unread: 0 };
  try {
    const client = await getClient(userId);
    const s = await client.status('INBOX', { unseen: true });
    return { connected: true, status: 'connected', unread: s.unseen || 0 };
  } catch (err) {
    return { connected: false, status: err.code === 'NEEDS_PASSWORD' ? 'needs_password' : 'error', unread: 0 };
  }
};

module.exports = {
  MailError,
  isAuthError,
  testLogin,
  getClient,
  closeClient,
  listFolders,
  listMessages,
  getMessage,
  streamAttachment,
  setSeen,
  unreadCount,
  dispositionHeader,
  _pool: pool,
};
