const db = require('../models');
const session = require('./mailSession');
const threads = require('./mailThreads');
const { getMailConfig } = require('../utils/mailConfig');

const { StaffMailAccount } = db;

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 5 — the 5-minute mail checker (Emu, 27 Sep).
//
// Every 5 minutes, for each CONNECTED mailbox in turn: one short login (the
// same session.openForUser path as everything else — domain check, two
// refusals park the account), INBOX and Sent opened READ-ONLY, only messages
// newer than the last check fetched (envelope + threading headers + structure;
// the text only when the message replies into a patient thread), then logout.
//
//   every new message → a StaffMailTraffic row (metadata only) — the Activity
//                       Log + Analytics "every email sent + received"
//   a reply into a    → stored on that patient's thread (PatientEmailMessages)
//   patient thread
//
// The first check of a mailbox (or after the server renumbers a folder —
// a new UIDVALIDITY) records a starting point and backfills NOTHING: history
// before phase 5 is not logged. Never changes a flag; never logs content.
// ---------------------------------------------------------------------------

const INTERVAL_MS = 5 * 60 * 1000;
const PER_FOLDER_MAX = 300;          // messages per folder per check
const ACCOUNT_TIMEOUT_MS = 90 * 1000;

let timer = null;
let running = false;

const readState = (row) => {
  try { const s = JSON.parse(row.syncState || '{}'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
};

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms)),
]);

/** Check one folder; returns the new cursor and counts. */
const syncFolder = async (client, { userId, ownAddress, path, direction, cursor }) => {
  const status = await client.status(path, { uidNext: true, uidValidity: true });
  const uidValidity = String(status.uidValidity);
  if (!cursor || String(cursor.uidValidity) !== uidValidity) {
    return { cursor: { uidValidity, uidNext: status.uidNext }, seen: 0, stored: 0, started: true };
  }
  if (!(status.uidNext > cursor.uidNext)) return { cursor, seen: 0, stored: 0 };

  const lock = await client.getMailboxLock(path, { readOnly: true });
  let seen = 0; let stored = 0; let next = cursor.uidNext;
  try {
    const msgs = [];
    for await (const msg of client.fetch(`${cursor.uidNext}:*`, {
      uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: threads.HEADER_FIELDS,
    }, { uid: true })) {
      if (msg.uid >= cursor.uidNext) msgs.push(msg);   // "n:*" also returns the last message when nothing is newer
      if (msgs.length >= PER_FOLDER_MAX) break;
    }
    msgs.sort((a, b) => a.uid - b.uid);
    for (const msg of msgs) {
      const r = await threads.ingestMessage(client, { userId, ownAddress, folder: path, uidValidity, msg, direction });
      seen += 1;
      stored += r.stored || 0;
      next = Math.max(next, msg.uid + 1);
    }
    if (msgs.length < PER_FOLDER_MAX) next = Math.max(next, status.uidNext);
  } finally {
    lock.release();
  }
  return { cursor: { uidValidity, uidNext: next }, seen, stored };
};

/** Check one mailbox. Never throws; returns a small summary (no content). */
const syncAccount = async (row) => {
  const userId = row.userId;
  let client;
  try {
    client = await session.openForUser(userId, { markConnected: true });
    const state = readState(row);
    const sent = session.findSpecial(await client.list(), 'sent');
    const out = { userId, seen: 0, stored: 0 };
    for (const [path, direction] of [['INBOX', 'in'], ...(sent ? [[sent, 'out']] : [])]) {
      const r = await syncFolder(client, { userId, ownAddress: String(row.emailAddress).toLowerCase(), path, direction, cursor: state[path] });
      state[path] = r.cursor;
      out.seen += r.seen; out.stored += r.stored;
    }
    await StaffMailAccount.update({ syncState: JSON.stringify(state), lastSyncAt: new Date() }, { where: { id: row.id } });
    return out;
  } catch (err) {
    // Not connected / parked / unreachable: skip quietly until next time.
    if (!['NOT_CONNECTED', 'NEEDS_PASSWORD', 'NOT_ALLOWED'].includes(err.code)) {
      console.error('[MailSync] mailbox check failed:', err.code || err.name || 'error');
    }
    return { userId, error: err.code || 'error' };
  } finally {
    if (client) client.logout().catch(() => {});
  }
};

/** One pass over every connected mailbox, one at a time. */
const runSync = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    const config = await getMailConfig();
    if (!config.enabled || !config.domains.length) return { disabled: true };
    const rows = await StaffMailAccount.findAll({ where: { status: 'connected' } });
    const results = [];
    for (const row of rows) {
      if (!row.passwordEncrypted) continue;
      results.push(await withTimeout(syncAccount(row), ACCOUNT_TIMEOUT_MS).catch((err) => ({ userId: row.userId, error: err.code || 'error' })));
    }
    return { accounts: results.length, results };
  } finally {
    running = false;
  }
};

const startScheduler = () => {
  if (timer) return;
  if (process.env.MAIL_SYNC_DISABLED === '1') { console.log('[MailSync] mailbox checker disabled (MAIL_SYNC_DISABLED=1).'); return; }
  const tick = () => runSync().catch((err) => console.error('[MailSync] pass failed:', err.code || err.message));
  setTimeout(tick, 30 * 1000).unref?.();   // first pass shortly after boot
  timer = setInterval(tick, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[MailSync] mailbox checker armed (every 5 minutes).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { runSync, syncAccount, startScheduler, stopScheduler, INTERVAL_MS, _internals: { syncFolder, readState } };
