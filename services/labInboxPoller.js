const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../models');
const { broadcast } = require('../utils/sseManager');
const { getLabInboxConfig, recordLastPoll, isSenderAllowed } = require('../utils/labInboxConfig');
const { suggestForReport } = require('../utils/labReportMatch');
const { formatFileSize } = require('../utils/medicalDocumentCreate');

const { LabInboxItem } = db;

// ---------------------------------------------------------------------------
// Lab Inbox poller — pulls external lab-report PDFs from the clinic mailbox
// over IMAP (imapflow) into LabInboxItems for staff to pair.
//
// Rules it lives by:
//   • Only mail from the admin's SENDER ALLOWLIST is ever opened. Anything else
//     is left untouched — not read, not flagged, not downloaded.
//   • Idempotent. Dedup on (messageId, attachmentIndex) — a re-poll, a restart,
//     or a lab re-sending the same email never double-files a report.
//   • One run at a time (in-memory lock) so a slow mailbox and the scheduler
//     can't overlap.
//   • Never throws into the API. runPoll() reports a summary; the scheduler
//     swallows and logs. A single bad message is recorded and skipped.
//   • Staged PDFs go to private/lab-inbox/ — deliberately OUTSIDE uploads/,
//     which app.js serves statically without auth. They are only reachable
//     through the authenticated GET /api/lab-inbox/:id/file.
//
// Provider-agnostic: host/port/secure come from System Settings (one.com,
// Gmail, M365, anything IMAP). No credentials ship with the code.
// ---------------------------------------------------------------------------

const STAGING_DIR = path.join(__dirname, '..', 'private', 'lab-inbox');
const MAX_MESSAGES_PER_RUN = 50;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;   // mirrors the upload cap

let running = false;
let timer = null;
let lastScheduledRunAt = 0;

const ensureStagingDir = () => {
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
};

const isPdfPart = (node) => {
  const type = (node.type || '').toLowerCase();
  const fname = (node.dispositionParameters && node.dispositionParameters.filename)
             || (node.parameters && node.parameters.name) || '';
  return type === 'application/pdf' || /\.pdf$/i.test(fname);
};

/** Walk an imapflow bodyStructure and return the PDF parts, in document order. */
const collectPdfParts = (node, out = []) => {
  if (!node) return out;
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) collectPdfParts(child, out);
  } else if (isPdfPart(node)) {
    out.push(node);
  }
  return out;
};

const partFilename = (node, fallback) => {
  const raw = (node.dispositionParameters && node.dispositionParameters.filename)
           || (node.parameters && node.parameters.name) || fallback;
  return String(raw).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
};

const streamToFile = (stream, dest) => new Promise((resolve, reject) => {
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  stream.on('data', (c) => { bytes += c.length; if (bytes > MAX_ATTACHMENT_BYTES) stream.destroy(new Error('Attachment exceeds 25 MB')); });
  stream.on('error', (e) => { out.destroy(); reject(e); });
  out.on('error', reject);
  out.on('finish', () => resolve(bytes));
  stream.pipe(out);
});

const openClient = async (cfg) => {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: !!cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    // Fail fast: a mailbox that is down must not hang the API request or the scheduler.
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
  await client.connect();
  return client;
};

/**
 * Connection check for the settings screen. Accepts unsaved form values;
 * falls back to the stored password when none is supplied.
 */
const testConnection = async (overrides = {}) => {
  const stored = await getLabInboxConfig({ redact: false });
  const cfg = { ...stored, ...overrides, password: overrides.password || stored.password };
  if (!cfg.host || !cfg.user || !cfg.password) {
    throw new Error('Host, email address and password are all required.');
  }
  const client = await openClient(cfg);
  try {
    const status = await client.status(cfg.mailbox || 'INBOX', { messages: true, unseen: true });
    return { ok: true, mailbox: cfg.mailbox || 'INBOX', messages: status.messages, unseen: status.unseen };
  } finally {
    await client.logout().catch(() => {});
  }
};

/**
 * One poll of the mailbox. Returns a summary; throws only on a connection /
 * auth failure (so a manual "Pull now" can tell the user).
 */
const runPoll = async ({ trigger = 'manual', userId = null } = {}) => {
  if (running) return { ok: true, skipped: true, reason: 'A mailbox check is already running.' };
  running = true;
  const started = Date.now();
  const summary = { ok: true, trigger, checked: 0, imported: 0, duplicates: 0, ignoredSenders: 0, noPdf: 0, errors: [] };

  let client;
  try {
    const cfg = await getLabInboxConfig({ redact: false });
    if (!cfg.isConfigured) throw new Error('The lab mailbox is not set up. Configure it in System Settings → Lab Inbox.');
    if (!cfg.allowlist.length) throw new Error('The lab sender allowlist is empty — add at least one lab address in System Settings → Lab Inbox.');

    ensureStagingDir();
    client = await openClient(cfg);
    const lock = await client.getMailboxLock(cfg.mailbox || 'INBOX');
    try {
      // With markRead/move, "unseen" is exactly "not yet processed". With
      // 'none' we can't rely on flags, so look back a few days and let dedup
      // do the rest.
      const query = cfg.afterImport === 'none'
        ? { since: new Date(Date.now() - 3 * 24 * 3600 * 1000) }
        : { seen: false };
      let uids = await client.search(query, { uid: true });
      if (!Array.isArray(uids)) uids = [];
      uids = uids.slice(-MAX_MESSAGES_PER_RUN);   // newest N if the backlog is huge

      for (const uid of uids) {
        let msg;
        try {
          msg = await client.fetchOne(uid, { uid: true, envelope: true, bodyStructure: true }, { uid: true });
        } catch (e) {
          summary.errors.push({ uid, error: `fetch: ${e.message}` });
          continue;
        }
        if (!msg || !msg.envelope) continue;
        summary.checked += 1;

        const from = (msg.envelope.from && msg.envelope.from[0]) || {};
        const senderEmail = (from.address || '').toLowerCase();
        const senderName = from.name || senderEmail;

        if (!isSenderAllowed(senderEmail, cfg.allowlist)) {
          summary.ignoredSenders += 1;
          continue;   // never touched
        }

        const messageId = msg.envelope.messageId || `uid:${cfg.user}:${cfg.mailbox}:${uid}`;
        const subject = msg.envelope.subject || '';
        const emailDate = msg.envelope.date ? new Date(msg.envelope.date) : null;
        const pdfParts = collectPdfParts(msg.bodyStructure);

        if (!pdfParts.length) {
          summary.noPdf += 1;
        }

        let touched = 0;
        for (let i = 0; i < pdfParts.length; i += 1) {
          const part = pdfParts[i];
          try {
            const existing = await LabInboxItem.findOne({ where: { messageId, attachmentIndex: i }, attributes: ['id'] });
            if (existing) { summary.duplicates += 1; touched += 1; continue; }

            const fileName = partFilename(part, `report-${uid}-${i}.pdf`);
            const stagedName = `${crypto.randomBytes(16).toString('hex')}.pdf`;
            const stagedPath = path.join(STAGING_DIR, stagedName);

            const { content } = await client.download(uid, part.part, { uid: true });
            const bytes = await streamToFile(content, stagedPath);

            const item = await LabInboxItem.create({
              mailbox: cfg.mailbox || 'INBOX',
              messageId,
              imapUid: uid,
              attachmentIndex: i,
              senderEmail,
              senderName,
              subject: subject.slice(0, 255),
              emailDate,
              fileName,
              filePath: stagedPath,
              fileUrl: null,   // set below once we have the id
              fileSize: formatFileSize(bytes),
              mimeType: 'application/pdf',
              status: 'New',
            });
            await item.update({ fileUrl: `/api/lab-inbox/${item.id}/file` });

            // Advisory suggestion — isolated; a bad PDF must never undo the import.
            try {
              const s = await suggestForReport({ filePath: stagedPath, subject, senderName });
              await item.update(s);
            } catch (se) {
              console.error('[LabInbox] suggestion failed (non-fatal):', se.message);
            }

            summary.imported += 1;
            touched += 1;
          } catch (e) {
            summary.errors.push({ uid, attachment: i, error: e.message });
            console.error(`[LabInbox] uid ${uid} attachment ${i}:`, e.message);
          }
        }

        // Post-import handling — only for allowlisted senders we actually processed
        // (a message with no PDF is still marked so it isn't rescanned every run).
        try {
          if (cfg.afterImport === 'markRead' || (cfg.afterImport === 'move' && !touched)) {
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          } else if (cfg.afterImport === 'move' && touched) {
            try {
              await client.messageMove(uid, cfg.moveFolder, { uid: true });
            } catch (mvErr) {
              // folder may not exist yet — create once, retry once
              await client.mailboxCreate(cfg.moveFolder).catch(() => {});
              await client.messageMove(uid, cfg.moveFolder, { uid: true });
            }
          }
        } catch (e) {
          summary.errors.push({ uid, error: `post-import: ${e.message}` });
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    summary.ok = false;
    summary.error = err.message;
    console.error('[LabInbox] poll failed:', err.message);
    summary.durationMs = Date.now() - started;
    await recordLastPoll(summary).catch(() => {});
    running = false;
    throw err;
  } finally {
    if (client) await client.logout().catch(() => {});
  }

  summary.durationMs = Date.now() - started;
  await recordLastPoll(summary).catch(() => {});
  running = false;

  if (summary.imported > 0) {
    try {
      const pending = await LabInboxItem.count({ where: { status: 'New' } });
      broadcast('lab_inbox_new', { imported: summary.imported, pending, trigger, at: new Date().toISOString() });
    } catch { /* ignore */ }
  }
  console.log(`[LabInbox] ${trigger}: checked ${summary.checked}, imported ${summary.imported}, dup ${summary.duplicates}, ignored ${summary.ignoredSenders}, errors ${summary.errors.length} (${summary.durationMs} ms)`);
  return summary;
};

/**
 * Scheduler. Ticks every minute and re-reads the config, so an admin turning
 * auto-import on/off or changing the interval takes effect without a restart.
 * Started once from server.js after the API is listening.
 */
const startScheduler = () => {
  if (timer) return;
  const TICK_MS = 60 * 1000;
  timer = setInterval(async () => {
    try {
      const cfg = await getLabInboxConfig();
      if (!cfg.enabled || !cfg.isConfigured || !cfg.allowlist.length) return;
      const due = Date.now() - lastScheduledRunAt >= cfg.pollIntervalMin * 60 * 1000;
      if (!due) return;
      lastScheduledRunAt = Date.now();
      await runPoll({ trigger: 'schedule' });
    } catch (err) {
      // already logged + recorded inside runPoll; never let the timer die
    }
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('[LabInbox] scheduler armed (checks config every minute).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { runPoll, testConnection, startScheduler, stopScheduler, STAGING_DIR, collectPdfParts };
