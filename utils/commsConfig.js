const db = require('../models');

const { Setting } = db;

// ---------------------------------------------------------------------------
// Communications Inbox — WhatsApp (Meta Cloud API) connection + behaviour,
// stored in the Setting table. Same read/write pattern as utils/labInboxConfig.
//
// NOTHING here ships pre-filled. The system has no WhatsApp until an admin
// enters the credentials on System Settings → WhatsApp. The three credentials —
// the Meta App Secret (verifies every webhook signature), the permanent System
// User access token (sends messages), and our own webhook verify token — are
// stored ENCRYPTED with utils/crypto.js (AES-256-CBC, CARELINK_ENCRYPTION_KEY,
// the key the app already has) and are never returned to the browser by
// getCommsConfig({ redact: true }). Only the webhook and the API caller read
// them decrypted.
//
// The clinic's phone number(s) are NOT here — a number is a MessagingChannel
// row (its phone_number_id, display number, quality rating), because a WABA can
// hold several and each is a routing target for the webhook.
// ---------------------------------------------------------------------------

const K = {
  wabaId:             'comms.wabaId',            // WhatsApp Business Account id
  appId:              'comms.appId',             // Meta developer app id
  appSecret:          'comms.appSecret',         // encrypted — webhook signature key
  accessToken:        'comms.accessToken',       // encrypted — System User token (sends)
  verifyToken:        'comms.verifyToken',       // encrypted — our webhook handshake token
  graphVersion:       'comms.graphVersion',      // Graph API version, e.g. v25.0
  pageId:             'comms.pageId',             // Facebook Page id — Messenger channel + webhook routing
  igId:               'comms.igId',               // Instagram account id — IG channel + webhook routing
  pageAccessToken:    'comms.pageAccessToken',    // encrypted — Page access token (sends Messenger + Instagram)
  autoLink:           'comms.autoLink',           // link a thread to a patient on a unique phone match
  markReadOnOpen:     'comms.markReadOnOpen',     // send Meta read receipts when staff open a thread
  warnNoConsent:      'comms.warnNoConsent',      // warn (not block) when sending to a non-opted-in patient
  archiveUnlinkedDays:'comms.archiveUnlinkedDays',// auto-archive an unlinked thread after N days
  mediaMaxMb:         'comms.mediaMaxMb',          // cap on an inbound media download
  monthlyBudgetKes:   'comms.monthlyBudgetKes',    // Costs banner threshold
  lastWebhookAt:      'comms.lastWebhookAt',       // runtime status for the UI
};

const DEFAULTS = {
  wabaId: '',
  appId: '',
  pageId: '',
  igId: '',
  graphVersion: 'v25.0',
  autoLink: true,
  markReadOnOpen: true,
  warnNoConsent: true,
  archiveUnlinkedDays: 90,
  mediaMaxMb: 25,
  monthlyBudgetKes: 0,
};

// Which stored keys are secrets — never returned to the browser, logged as
// "(changed)" by the settings audit.
const SECRET_FIELDS = ['appSecret', 'accessToken', 'verifyToken', 'pageAccessToken'];

// Lazy so a missing CARELINK_ENCRYPTION_KEY fails with a clear message when a
// secret is saved/used, not by crashing the API at boot.
const cryptoUtil = () => {
  if (!process.env.CARELINK_ENCRYPTION_KEY) {
    throw new Error('CARELINK_ENCRYPTION_KEY is not set — it is required to store the WhatsApp credentials securely.');
  }
  return require('./crypto');
};

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearCommsCache = () => { cached = { rows: null, at: 0 }; };

const readRows = async () => {
  if (cached.rows && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const rows = await Setting.findAll({ where: { key: Object.values(K) } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cached = { rows: map, at: Date.now() };
  return map;
};

const bool = (raw, def) => (raw === undefined ? def : raw === 'true');
const int = (raw, def) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
};

/**
 * Read the config. With { redact: true } (the default — what the settings API
 * returns to the browser) each secret is replaced by a `has<Name>` boolean.
 */
const getCommsConfig = async ({ redact = true } = {}) => {
  const m = await readRows();
  const cfg = {
    wabaId:              m[K.wabaId] || DEFAULTS.wabaId,
    appId:               m[K.appId] || DEFAULTS.appId,
    pageId:              m[K.pageId] || DEFAULTS.pageId,
    igId:                m[K.igId] || DEFAULTS.igId,
    graphVersion:        m[K.graphVersion] || DEFAULTS.graphVersion,
    autoLink:            bool(m[K.autoLink], DEFAULTS.autoLink),
    markReadOnOpen:      bool(m[K.markReadOnOpen], DEFAULTS.markReadOnOpen),
    warnNoConsent:       bool(m[K.warnNoConsent], DEFAULTS.warnNoConsent),
    archiveUnlinkedDays: int(m[K.archiveUnlinkedDays], DEFAULTS.archiveUnlinkedDays),
    mediaMaxMb:          int(m[K.mediaMaxMb], DEFAULTS.mediaMaxMb),
    monthlyBudgetKes:    int(m[K.monthlyBudgetKes], DEFAULTS.monthlyBudgetKes),
    hasAppSecret:        !!m[K.appSecret],
    hasAccessToken:      !!m[K.accessToken],
    hasVerifyToken:      !!m[K.verifyToken],
    hasPageAccessToken:  !!m[K.pageAccessToken],
    lastWebhookAt:       m[K.lastWebhookAt] || null,
  };
  // Enough to receive (verify + secret) and send (token). Numbers are added
  // separately as MessagingChannels; "connected" here means the credentials.
  cfg.isConfigured = !!(cfg.hasAppSecret && cfg.hasAccessToken && cfg.hasVerifyToken);
  // Messenger / Instagram share the app secret + verify token (one webhook) but
  // send through a Facebook Page access token. A channel is "connectable" once
  // its id and the page token are present (business verification aside).
  cfg.isMessengerConfigured  = !!(cfg.hasAppSecret && cfg.hasVerifyToken && cfg.hasPageAccessToken && cfg.pageId);
  cfg.isInstagramConfigured  = !!(cfg.hasAppSecret && cfg.hasVerifyToken && cfg.hasPageAccessToken && cfg.igId);
  if (!redact) {
    const c = cryptoUtil();
    cfg.appSecret       = m[K.appSecret]       ? c.decrypt(m[K.appSecret])       : '';
    cfg.accessToken     = m[K.accessToken]     ? c.decrypt(m[K.accessToken])     : '';
    cfg.verifyToken     = m[K.verifyToken]     ? c.decrypt(m[K.verifyToken])     : '';
    cfg.pageAccessToken = m[K.pageAccessToken] ? c.decrypt(m[K.pageAccessToken]) : '';
  }
  return cfg;
};

/** Write whichever fields are passed; everything else is left alone. */
const setCommsConfig = async (changes = {}) => {
  const write = async (key, value) => {
    const v = value == null ? '' : String(value);
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value: v } });
    if (!created && row.value !== v) await row.update({ value: v });
  };

  if (changes.wabaId !== undefined)       await write(K.wabaId, changes.wabaId.trim());
  if (changes.appId !== undefined)        await write(K.appId, changes.appId.trim());
  if (changes.pageId !== undefined)       await write(K.pageId, changes.pageId.trim());
  if (changes.igId !== undefined)         await write(K.igId, changes.igId.trim());
  if (changes.pageAccessToken)            await write(K.pageAccessToken, cryptoUtil().encrypt(changes.pageAccessToken));
  if (changes.graphVersion !== undefined) await write(K.graphVersion, changes.graphVersion.trim() || DEFAULTS.graphVersion);
  if (changes.appSecret)                  await write(K.appSecret, cryptoUtil().encrypt(changes.appSecret));
  if (changes.accessToken)                await write(K.accessToken, cryptoUtil().encrypt(changes.accessToken));
  if (changes.verifyToken)                await write(K.verifyToken, cryptoUtil().encrypt(changes.verifyToken));
  if (changes.autoLink !== undefined)       await write(K.autoLink, changes.autoLink ? 'true' : 'false');
  if (changes.markReadOnOpen !== undefined) await write(K.markReadOnOpen, changes.markReadOnOpen ? 'true' : 'false');
  if (changes.warnNoConsent !== undefined)  await write(K.warnNoConsent, changes.warnNoConsent ? 'true' : 'false');
  if (changes.archiveUnlinkedDays !== undefined) {
    const n = parseInt(changes.archiveUnlinkedDays, 10);
    if (!(n >= 0 && n <= 3650)) throw new Error('Archive-after must be 0–3650 days.');
    await write(K.archiveUnlinkedDays, n);
  }
  if (changes.mediaMaxMb !== undefined) {
    const n = parseInt(changes.mediaMaxMb, 10);
    if (!(n >= 1 && n <= 100)) throw new Error('Media size cap must be 1–100 MB.');
    await write(K.mediaMaxMb, n);
  }
  if (changes.monthlyBudgetKes !== undefined) {
    const n = parseInt(changes.monthlyBudgetKes, 10);
    if (!(n >= 0)) throw new Error('Monthly budget must be zero or more.');
    await write(K.monthlyBudgetKes, n);
  }

  clearCommsCache();
  return getCommsConfig();
};

/** Stamp the last time a valid webhook was received (runtime status). */
const recordWebhookSeen = async () => {
  const value = new Date().toISOString();
  const [row, created] = await Setting.findOrCreate({ where: { key: K.lastWebhookAt }, defaults: { key: K.lastWebhookAt, value } });
  if (!created) await row.update({ value });
  clearCommsCache();
};

module.exports = {
  KEYS: K,
  DEFAULTS,
  SECRET_FIELDS,
  getCommsConfig,
  setCommsConfig,
  recordWebhookSeen,
  clearCommsCache,
};
