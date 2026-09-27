const session = require('./mailSession');
const { addressList, displaySubject } = require('../utils/mailRender');

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 3b — the live INBOX watcher ("watch + 30 s check",
// Emu's decision of 26 Sep).
//
// While a person has the HMS open, their browser asks GET /api/mail/unread
// every 30 s. The first ask starts a watcher: ONE extra IMAP connection to
// that person's own mailbox (same credential path as every other mail call —
// session.openForUser), INBOX opened READ-ONLY (EXAMINE — it can never change
// a flag), sitting in IMAP IDLE. When the server says something changed
// (new mail, a message read or deleted on the phone), the watcher recounts and
// keeps { unread, latest } IN MEMORY. The 30 s asks are answered from that
// memory — no provider round-trip.
//
// Nothing is stored: the newest unread message's sender name + subject live
// in this process only, are returned only to their owner, and are never
// logged. When the asks stop (tab closed, logged out) the watcher closes
// itself after STOP_AFTER_MS. A PM2 restart simply starts over.
//
// Why not push over /api/sse: that stream is unauthenticated and broadcast to
// every open tab — it cannot carry one person's mail.
// ---------------------------------------------------------------------------

const STOP_AFTER_MS = 3 * 60 * 1000;      // no browser ask for this long → close
const RECHECK_MS = 2 * 60 * 1000;         // safety recount in case IDLE died quietly
const RETRY_AFTER_MS = 60 * 1000;         // after a failed start, don't retry sooner
const DEBOUNCE_MS = 400;
const MAX_WATCHERS = 200;

const watchers = new Map();   // userId -> { client, state, lastTouch, lastCheck, timer }
const starting = new Map();   // userId -> Promise<state>
const failed = new Map();     // userId -> { at, err }
let ticker = null;

const emptyState = () => ({ unread: 0, latest: null });

/** Recount unread INBOX mail and describe the newest unread message. */
const recount = async (userId, w) => {
  const { client } = w;
  const uids = (await client.search({ seen: false }, { uid: true })) || [];
  let latest = null;
  if (uids.length) {
    const newest = Math.max(...uids);
    const msg = await client.fetchOne(String(newest), { uid: true, envelope: true, internalDate: true }, { uid: true });
    if (msg) {
      const env = msg.envelope || {};
      const from = addressList(env.from)[0] || null;
      latest = {
        uid: msg.uid,
        uidValidity: String(client.mailbox && client.mailbox.uidValidity),
        from: from ? { name: from.name || '', address: from.address } : null,
        subject: displaySubject(env.subject),
        date: env.date || msg.internalDate || null,
      };
    }
  }
  w.state = { unread: uids.length, latest };
  w.lastCheck = Date.now();
  const cur = watchers.get(userId);
  return cur === w ? w.state : cur ? cur.state : w.state;
};

const scheduleRecount = (userId, w) => {
  if (w.timer) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    if (watchers.get(userId) !== w) return;
    recount(userId, w).catch((err) => console.error('[Mail] watcher recount failed:', err.code || err.message));
  }, DEBOUNCE_MS);
  if (w.timer.unref) w.timer.unref();
};

const startTicker = () => {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    for (const [userId, w] of watchers.entries()) {
      if (now - w.lastTouch > STOP_AFTER_MS) { stop(userId); continue; }
      if (now - w.lastCheck > RECHECK_MS) scheduleRecount(userId, w);
    }
  }, 30 * 1000);
  if (ticker.unref) ticker.unref();
};

const begin = async (userId) => {
  if (watchers.size >= MAX_WATCHERS) throw Object.assign(new Error('Too many live mail watchers'), { code: 'BUSY' });
  // IDLE 0.5 s after each recount (imapflow's default waits 15 s, which would
  // leave a window where new mail isn't heard about until the next IDLE).
  const client = await session.openForUser(userId, { markConnected: false, imapOptions: { autoIdleDelay: 500 } });
  const w = { client, state: emptyState(), lastTouch: Date.now(), lastCheck: 0, timer: null };
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
  } catch (err) {
    client.logout().catch(() => {});
    throw err;
  }
  // Server-side changes to INBOX while we IDLE: new mail, expunges, flag
  // changes made elsewhere (read on the phone, read in another HMS tab).
  const onChange = () => scheduleRecount(userId, w);
  client.on('exists', onChange);
  client.on('expunge', onChange);
  client.on('flags', onChange);
  client.on('close', () => { if (watchers.get(userId) === w) { if (w.timer) clearTimeout(w.timer); watchers.delete(userId); } });
  watchers.set(userId, w);
  startTicker();
  await recount(userId, w);
  return w.state;
};

/**
 * Called by every badge ask. Starts the watcher if there isn't one (at most
 * one start in flight per user), records the ask, and returns the state.
 */
const touch = async (userId) => {
  const w = watchers.get(userId);
  if (w && w.client && w.client.usable) { w.lastTouch = Date.now(); return w.state; }
  if (w) stop(userId);
  if (starting.has(userId)) return starting.get(userId);

  const recent = failed.get(userId);
  if (recent && Date.now() - recent.at < RETRY_AFTER_MS) throw recent.err;

  const p = begin(userId)
    .then((state) => { failed.delete(userId); return state; })
    .catch((err) => { failed.set(userId, { at: Date.now(), err }); throw err; })
    .finally(() => starting.delete(userId));
  starting.set(userId, p);
  return p;
};

/** Close this user's watcher (disconnect, wipe, password change, tab gone). Never throws. */
function stop(userId) {
  const w = watchers.get(userId);
  watchers.delete(userId);
  failed.delete(userId);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  if (w.client) w.client.logout().catch(() => {});
}

/** Force a recount now (after the user's own action changed INBOX in the pool connection). */
const nudge = (userId) => {
  const w = watchers.get(userId);
  if (w) scheduleRecount(userId, w);
};

module.exports = { touch, stop, nudge, _watchers: watchers, STOP_AFTER_MS };
