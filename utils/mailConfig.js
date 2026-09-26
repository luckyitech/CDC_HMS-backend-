const db = require('../models');
const { PROVIDER_KEYS, serversFor, isValidHost, isValidPort } = require('./mailProviders');

const { Setting } = db;

// ---------------------------------------------------------------------------
// Staff Email (B26) — clinic-wide settings, stored in the Setting table.
// Same read/write shape as utils/labInboxConfig.js.
//
//   mail.enabled          'true' | 'false' — the whole feature on/off
//   mail.domains          JSON [{ domain, provider, imapHost?, imapPort?, imapSecure?,
//                                  smtpHost?, smtpPort?, smtpSecure? }]
//                         Which addresses staff may connect, and the servers
//                         for each. NOTHING ships pre-filled: an admin enters
//                         the clinic's domain (the resale requirement — plan §4b).
//   mail.blockedAddresses JSON [address] — system mailboxes nobody may connect
//                         as a personal one. On top of this list the Lab Inbox
//                         mailbox and the system sender (SMTP_USER) are ALWAYS
//                         blocked: reading reports@ in My mail would mark lab
//                         reports read and the Lab Inbox poller (UNSEEN) would
//                         silently skip them.
// ---------------------------------------------------------------------------

const K = {
  enabled:          'mail.enabled',
  domains:          'mail.domains',
  blockedAddresses: 'mail.blockedAddresses',
};

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearMailCache = () => { cached = { rows: null, at: 0 }; };

const readRows = async () => {
  if (cached.rows && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const rows = await Setting.findAll({ where: { key: Object.values(K) } });
  cached = { rows: Object.fromEntries(rows.map((r) => [r.key, r.value])), at: Date.now() };
  return cached.rows;
};

const parseList = (raw) => {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};

const normEmail = (e) => String(e || '').trim().toLowerCase();
const domainOf = (email) => {
  const e = normEmail(email);
  const at = e.lastIndexOf('@');
  return at > 0 ? e.slice(at + 1) : '';
};
const EMAIL_RE = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Addresses the system itself uses — always blocked, whatever the admin list says. */
const systemAddresses = async () => {
  const out = new Set();
  if (process.env.SMTP_USER) out.add(normEmail(process.env.SMTP_USER));
  try {
    const { getLabInboxConfig } = require('./labInboxConfig');
    const lab = await getLabInboxConfig({ redact: true });
    if (lab.user) out.add(normEmail(lab.user));
  } catch { /* Lab Inbox not configured — nothing to add */ }
  return [...out].filter(Boolean);
};

const getMailConfig = async () => {
  const m = await readRows();
  const domains = parseList(m[K.domains]).map((d) => ({
    domain: String(d.domain || '').toLowerCase(),
    provider: PROVIDER_KEYS.includes(d.provider) ? d.provider : 'onecom',
    ...(d.provider === 'custom' ? {
      imapHost: d.imapHost || '', imapPort: Number(d.imapPort) || 993, imapSecure: d.imapSecure !== false,
      smtpHost: d.smtpHost || '', smtpPort: Number(d.smtpPort) || 465, smtpSecure: d.smtpSecure !== false,
    } : {}),
  })).filter((d) => d.domain);
  return {
    enabled: m[K.enabled] === undefined ? true : m[K.enabled] === 'true',
    domains,
    blockedAddresses: parseList(m[K.blockedAddresses]).map(normEmail).filter(Boolean),
    systemAddresses: await systemAddresses(),
  };
};

const writeSetting = async (key, value) => {
  const v = value == null ? '' : String(value);
  const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value: v } });
  if (!created && row.value !== v) await row.update({ value: v });
};

/** Write whichever fields are passed. Throws user-facing validation errors. */
const setMailConfig = async (changes = {}) => {
  if (changes.enabled !== undefined) await writeSetting(K.enabled, changes.enabled ? 'true' : 'false');

  if (changes.domains !== undefined) {
    if (!Array.isArray(changes.domains)) throw new Error('domains must be a list.');
    const seen = new Set();
    const clean = changes.domains.map((d) => {
      const domain = String(d?.domain || '').trim().toLowerCase().replace(/^@/, '');
      if (!DOMAIN_RE.test(domain)) throw new Error(`'${domain || '(blank)'}' is not a valid domain.`);
      if (seen.has(domain)) throw new Error(`'${domain}' is listed twice.`);
      seen.add(domain);
      const provider = String(d.provider || 'onecom');
      if (!PROVIDER_KEYS.includes(provider)) throw new Error(`Unknown provider '${provider}'.`);
      if (provider !== 'custom') return { domain, provider };
      if (!isValidHost(d.imapHost) || !isValidPort(d.imapPort) || !isValidHost(d.smtpHost) || !isValidPort(d.smtpPort)) {
        throw new Error(`Custom servers for ${domain} need a valid IMAP host/port and SMTP host/port.`);
      }
      return {
        domain, provider,
        imapHost: d.imapHost.trim(), imapPort: Number(d.imapPort), imapSecure: d.imapSecure !== false,
        smtpHost: d.smtpHost.trim(), smtpPort: Number(d.smtpPort), smtpSecure: d.smtpSecure !== false,
      };
    });
    await writeSetting(K.domains, JSON.stringify(clean));
  }

  if (changes.blockedAddresses !== undefined) {
    if (!Array.isArray(changes.blockedAddresses)) throw new Error('blockedAddresses must be a list.');
    const clean = [...new Set(changes.blockedAddresses.map(normEmail).filter(Boolean))];
    for (const e of clean) if (!EMAIL_RE.test(e)) throw new Error(`'${e}' is not a valid email address.`);
    await writeSetting(K.blockedAddresses, JSON.stringify(clean));
  }

  clearMailCache();
  return getMailConfig();
};

/**
 * May this address be connected as someone's personal mailbox, and with which
 * servers? Returns { ok: true, servers } or { ok: false, reason, code }.
 */
const checkAddress = async (email) => {
  const cfg = await getMailConfig();
  const e = normEmail(email);
  if (!cfg.enabled) return { ok: false, code: 'DISABLED', reason: 'Email in the HMS is switched off for this clinic.' };
  if (!EMAIL_RE.test(e)) return { ok: false, code: 'INVALID', reason: 'Enter a valid email address.' };
  if (!cfg.domains.length) {
    return { ok: false, code: 'NOT_SET_UP', reason: 'Your clinic has not set up email in the HMS yet. Ask the administrator.' };
  }
  const entry = cfg.domains.find((d) => d.domain === domainOf(e));
  if (!entry) {
    const list = cfg.domains.map((d) => `@${d.domain}`).join(', ');
    return { ok: false, code: 'DOMAIN', reason: `Only clinic addresses can be connected (${list}).` };
  }
  if (cfg.systemAddresses.includes(e) || cfg.blockedAddresses.includes(e)) {
    return { ok: false, code: 'BLOCKED', reason: 'That is a shared clinic mailbox the HMS uses itself, so it can\'t be connected as a personal mailbox.' };
  }
  const servers = serversFor(entry);
  if (!servers) return { ok: false, code: 'SERVERS', reason: 'The mail servers for this domain are not set up correctly. Ask the administrator.' };
  return { ok: true, servers };
};

module.exports = {
  KEYS: K,
  getMailConfig,
  setMailConfig,
  checkAddress,
  clearMailCache,
  normEmail,
  domainOf,
  EMAIL_RE,
};
