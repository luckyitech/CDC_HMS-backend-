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
  signature:        'mail.signature',       // JSON — the clinic part of every signature
  signatureLogo:    'mail.signatureLogo',   // data: URI of an uploaded logo, 'none', or '' (= the bundled default)
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

// ---------------------------------------------------------------------------
// The clinic signature (phase 2). Each person writes their own lines (name,
// title, direct line) in their email settings; the HMS adds this clinic block
// under them on every message they send. Set once by an admin in System
// Settings → Email. Until an admin changes it, it carries the clinic's
// letterhead details and the logo bundled with the backend.
// ---------------------------------------------------------------------------

const SIGNATURE_DEFAULTS = {
  clinicName: 'Comprehensive Diabetes Centre',
  address: '3rd Floor, Doctors Park, Third Avenue, Nairobi',
  phone: '0711 781299',
  email: 'info@cdiabetescentre.com',
  website: 'comprehensivediabetescentre.com',
  confidentialityOn: true,
  confidentialityText: 'Confidential: this email may contain patient information intended only for the addressee. If you received it in error, please tell the sender and delete it.',
};
const SIGNATURE_LIMITS = { clinicName: 120, address: 200, phone: 120, email: 120, website: 200, confidentialityText: 600 };
const DEFAULT_LOGO_PATH = require('path').join(__dirname, '..', 'logo', 'cdc_mark.png');
const MAX_LOGO_BYTES = 40 * 1024;   // kept small: it travels inside every email
const LOGO_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/;

let defaultLogo;
const readDefaultLogo = () => {
  if (defaultLogo === undefined) {
    try { defaultLogo = { type: 'image/png', buffer: require('fs').readFileSync(DEFAULT_LOGO_PATH) }; } catch { defaultLogo = null; }
  }
  return defaultLogo;
};

const parseObject = (raw) => {
  if (!raw) return {};
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/**
 * The clinic signature: { clinicName, address, phone, email, website,
 * confidentialityOn, confidentialityText, logo: { type, buffer } | null,
 * logoSource: 'default' | 'uploaded' | 'none' }.
 */
const getSignatureConfig = async () => {
  const m = await readRows();
  const saved = parseObject(m[K.signature]);
  const sig = { ...SIGNATURE_DEFAULTS };
  for (const k of Object.keys(SIGNATURE_DEFAULTS)) if (saved[k] !== undefined) sig[k] = saved[k];
  sig.confidentialityOn = sig.confidentialityOn !== false;

  const rawLogo = m[K.signatureLogo] || '';
  if (rawLogo === 'none') { sig.logo = null; sig.logoSource = 'none'; }
  else {
    const match = rawLogo.match(LOGO_RE);
    if (match) { sig.logo = { type: match[1], buffer: Buffer.from(match[2], 'base64') }; sig.logoSource = 'uploaded'; }
    else { sig.logo = readDefaultLogo(); sig.logoSource = sig.logo ? 'default' : 'none'; }
  }
  return sig;
};

/** For the admin screen and previews: the logo as a data: URI. */
const logoDataUri = (sig) => (sig.logo ? `data:${sig.logo.type};base64,${sig.logo.buffer.toString('base64')}` : null);

/**
 * Save the clinic signature. `logo`: a data: URI (PNG/JPEG ≤ 40 KB), 'none'
 * to show no logo, or 'default' for the bundled one. Throws user-facing
 * validation errors.
 */
const setSignatureConfig = async (changes = {}) => {
  const current = parseObject((await readRows())[K.signature]);
  const next = { ...current };
  for (const [k, max] of Object.entries(SIGNATURE_LIMITS)) {
    if (changes[k] === undefined) continue;
    const v = String(changes[k] == null ? '' : changes[k]).replace(/[\r\n]+/g, k === 'confidentialityText' ? ' ' : ' ').trim();
    if (v.length > max) throw new Error(`The signature's ${k} must be at most ${max} characters.`);
    next[k] = v;
  }
  if (changes.email !== undefined && next.email && !EMAIL_RE.test(next.email)) throw new Error(`'${next.email}' is not a valid email address.`);
  if (changes.confidentialityOn !== undefined) next.confidentialityOn = !!changes.confidentialityOn;
  await writeSetting(K.signature, JSON.stringify(next));

  if (changes.logo !== undefined) {
    const logo = String(changes.logo || '');
    if (logo === 'default') await writeSetting(K.signatureLogo, '');
    else if (logo === 'none') await writeSetting(K.signatureLogo, 'none');
    else {
      const match = logo.match(LOGO_RE);
      if (!match) throw new Error('The logo must be a PNG or JPEG image.');
      if (Buffer.from(match[2], 'base64').length > MAX_LOGO_BYTES) throw new Error('The logo must be at most 40 KB — it travels inside every email.');
      await writeSetting(K.signatureLogo, logo);
    }
  }
  clearMailCache();
  return getSignatureConfig();
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
  getSignatureConfig,
  setSignatureConfig,
  logoDataUri,
  SIGNATURE_DEFAULTS,
  normEmail,
  domainOf,
  EMAIL_RE,
};
