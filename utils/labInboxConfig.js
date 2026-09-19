const db = require('../models');

const { Setting } = db;

// ---------------------------------------------------------------------------
// Lab Inbox — mailbox connection + import policy, stored in the Setting table.
//
// NOTHING here ships pre-filled. The system has no mailbox until an admin
// enters one on System Settings → Lab Inbox, which is what lets any clinic
// adopt the feature. Same read/write pattern as utils/passwordRotation.js
// (findOrCreate + update, short cache).
//
// The mailbox password is stored ENCRYPTED with utils/crypto.js (AES-256-CBC,
// keyed by CARELINK_ENCRYPTION_KEY — the key the app already has). It is never
// returned by getConfig({ redact: true }), which is what the settings API
// serves; only the poller reads it decrypted.
// ---------------------------------------------------------------------------

const K = {
  host:            'labInbox.host',
  port:            'labInbox.port',
  secure:          'labInbox.secure',          // 'true' | 'false'  (IMAPS on 993)
  user:            'labInbox.user',            // the mailbox address, e.g. reports@clinic.com
  password:        'labInbox.password',        // encrypted
  mailbox:         'labInbox.mailbox',         // folder, default INBOX
  enabled:         'labInbox.enabled',         // auto-import on/off
  pollIntervalMin: 'labInbox.pollIntervalMin',
  afterImport:     'labInbox.afterImport',     // 'markRead' | 'move' | 'none'
  moveFolder:      'labInbox.moveFolder',
  allowlist:       'labInbox.allowlist',       // JSON array of addresses / @domains
  lastPoll:        'labInbox.lastPoll',        // JSON — runtime status for the UI
};

const DEFAULTS = {
  host: '',
  port: 993,
  secure: true,
  user: '',
  mailbox: 'INBOX',
  enabled: false,
  pollIntervalMin: 10,
  afterImport: 'markRead',
  moveFolder: 'CDC-Imported',
  allowlist: [],
};

const AFTER_IMPORT = ['markRead', 'move', 'none'];
const POLL_MIN = 1;
const POLL_MAX = 24 * 60;

// Lazy so a missing CARELINK_ENCRYPTION_KEY fails with a clear message at the
// moment a password is saved/used, not by crashing the whole API at boot.
const cryptoUtil = () => {
  if (!process.env.CARELINK_ENCRYPTION_KEY) {
    throw new Error('CARELINK_ENCRYPTION_KEY is not set — it is required to store the mailbox password securely.');
  }
  return require('./crypto');
};

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearLabInboxCache = () => { cached = { rows: null, at: 0 }; };

const readRows = async () => {
  if (cached.rows && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const rows = await Setting.findAll({ where: { key: Object.values(K) } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cached = { rows: map, at: Date.now() };
  return map;
};

const parseAllowlist = (raw) => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];
  } catch { return []; }
};

/**
 * Read the config. With { redact: true } the password is replaced by a
 * boolean `hasPassword` — the shape the settings API returns to the browser.
 */
const getLabInboxConfig = async ({ redact = true } = {}) => {
  const m = await readRows();
  const cfg = {
    host:            m[K.host] || DEFAULTS.host,
    port:            parseInt(m[K.port], 10) || DEFAULTS.port,
    secure:          m[K.secure] === undefined ? DEFAULTS.secure : m[K.secure] === 'true',
    user:            m[K.user] || DEFAULTS.user,
    mailbox:         m[K.mailbox] || DEFAULTS.mailbox,
    enabled:         m[K.enabled] === 'true',
    pollIntervalMin: parseInt(m[K.pollIntervalMin], 10) || DEFAULTS.pollIntervalMin,
    afterImport:     AFTER_IMPORT.includes(m[K.afterImport]) ? m[K.afterImport] : DEFAULTS.afterImport,
    moveFolder:      m[K.moveFolder] || DEFAULTS.moveFolder,
    allowlist:       parseAllowlist(m[K.allowlist]),
    hasPassword:     !!m[K.password],
    lastPoll:        (() => { try { return m[K.lastPoll] ? JSON.parse(m[K.lastPoll]) : null; } catch { return null; } })(),
  };
  cfg.isConfigured = !!(cfg.host && cfg.user && cfg.hasPassword);
  if (!redact) {
    cfg.password = m[K.password] ? cryptoUtil().decrypt(m[K.password]) : '';
  }
  return cfg;
};

/**
 * Write whichever fields are passed; everything else is left alone.
 * `password` is encrypted; an empty/undefined password leaves the stored one.
 */
const setLabInboxConfig = async (changes = {}) => {
  const write = async (key, value) => {
    const v = value == null ? '' : String(value);
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value: v } });
    if (!created && row.value !== v) await row.update({ value: v });
  };

  if (changes.host !== undefined)    await write(K.host, changes.host.trim());
  if (changes.port !== undefined) {
    const p = parseInt(changes.port, 10);
    if (!(p > 0 && p < 65536)) throw new Error('Port must be between 1 and 65535.');
    await write(K.port, p);
  }
  if (changes.secure !== undefined)  await write(K.secure, changes.secure ? 'true' : 'false');
  if (changes.user !== undefined)    await write(K.user, changes.user.trim());
  if (changes.password)              await write(K.password, cryptoUtil().encrypt(changes.password));
  if (changes.mailbox !== undefined) await write(K.mailbox, changes.mailbox.trim() || DEFAULTS.mailbox);
  if (changes.enabled !== undefined) await write(K.enabled, changes.enabled ? 'true' : 'false');
  if (changes.pollIntervalMin !== undefined) {
    const n = parseInt(changes.pollIntervalMin, 10);
    if (!(n >= POLL_MIN && n <= POLL_MAX)) throw new Error(`Poll interval must be ${POLL_MIN}–${POLL_MAX} minutes.`);
    await write(K.pollIntervalMin, n);
  }
  if (changes.afterImport !== undefined) {
    if (!AFTER_IMPORT.includes(changes.afterImport)) throw new Error(`afterImport must be one of ${AFTER_IMPORT.join(', ')}.`);
    await write(K.afterImport, changes.afterImport);
  }
  if (changes.moveFolder !== undefined) await write(K.moveFolder, changes.moveFolder.trim() || DEFAULTS.moveFolder);
  if (changes.allowlist !== undefined) {
    if (!Array.isArray(changes.allowlist)) throw new Error('allowlist must be an array.');
    const clean = [...new Set(changes.allowlist.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
    for (const entry of clean) {
      // an address "a@b.c" or a bare domain "@b.c"
      if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/i.test(entry)) {
        throw new Error(`'${entry}' is not a valid email address or @domain.`);
      }
    }
    await write(K.allowlist, JSON.stringify(clean));
  }

  clearLabInboxCache();
  return getLabInboxConfig();
};

/** Record the outcome of a poll for the UI ("Last synced 3 min ago", errors). */
const recordLastPoll = async (result) => {
  const value = JSON.stringify({ at: new Date().toISOString(), ...result });
  const [row, created] = await Setting.findOrCreate({ where: { key: K.lastPoll }, defaults: { key: K.lastPoll, value } });
  if (!created) await row.update({ value });
  clearLabInboxCache();
};

/**
 * Sender allowlist check. Matches an exact address or a bare @domain entry.
 * An EMPTY allowlist allows nothing — the safe default until the admin adds
 * the labs (the poller never touches non-lab mail).
 */
const isSenderAllowed = (email, allowlist) => {
  if (!email || !Array.isArray(allowlist) || allowlist.length === 0) return false;
  const addr = String(email).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at) : '';
  return allowlist.some((e) => (e.startsWith('@') ? e === domain : e === addr));
};

module.exports = {
  KEYS: K,
  DEFAULTS,
  AFTER_IMPORT,
  getLabInboxConfig,
  setLabInboxConfig,
  recordLastPoll,
  clearLabInboxCache,
  isSenderAllowed,
};
