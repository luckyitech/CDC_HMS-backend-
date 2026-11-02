const db = require('../models');
const { parseHoursDefault } = require('./workHours');
const { parseNetwork, formatNetwork } = require('./ip');

const { Setting } = db;

// ---------------------------------------------------------------------------
// Sign-in security (16 Oct 2026, Emu) — the clinic's own networks, whether
// outside addresses are looked up, whether the browser is asked for its
// location at sign-in, and when a sign-in is flagged as suspicious. Same
// read-with-cache + DEFAULTS pattern as utils/hrConfig.js and utils/commsConfig.js.
//
// Written only by holders of it.security.settings (or the main admin account),
// audited through services/settingChangeLog.js (area 'Sign-in security').
// The one secret — a lookup service token — is encrypted and never returned.
//
// Location lookup and device location both start OFF: turning either on sends
// staff data somewhere (an outside service; the browser's location prompt),
// which is a decision the clinic takes, not a default it inherits.
// ---------------------------------------------------------------------------

const K = {
  networks:       'security.signin.networks',        // JSON [{ value, label }]
  lookupEnabled:  'security.signin.lookupEnabled',   // 'true' | 'false'
  lookupProvider: 'security.signin.lookupProvider',  // see PROVIDERS
  lookupToken:    'security.signin.lookupToken',     // encrypted
  gpsMode:        'security.signin.gpsMode',         // 'off' | 'ask'
  alertsEnabled:  'security.signin.alertsEnabled',   // 'true' | 'false'
  alertChannels:  'security.signin.alertChannels',   // JSON { bell, email }
  rules:          'security.signin.rules',           // JSON, see DEFAULT_RULES
  hours:          'security.signin.hours',           // JSON, utils/workHours parseHoursDefault format
  // The network lock (16 Oct 2026): outside the clinic's networks only people
  // with remote access (it.remote.signin) may sign in and work.
  lockOutside:    'security.signin.lockOutside',     // 'true' | 'false'
  lockTapExempt:  'security.signin.lockTapExempt',   // 'true' | 'false' — registered check-in phones at the entrance tag
};

// ipapi: ipapi.co, no key (about 1,000 lookups a day free). ipinfo: ipinfo.io
// with the clinic's own token. Each outside address is looked up once and kept.
const PROVIDERS = ['ipapi', 'ipinfo'];
const GPS_MODES = ['off', 'ask'];

const DEFAULT_RULES = {
  newDevice: true,           // first sign-in from a device label this person has not used
  newCountry: true,          // first sign-in from a country this person has not signed in from
  outsideClinic: false,      // any sign-in from outside the clinic's networks
  failedAttempts: true,      // repeated wrong passwords on one account
  failedCount: 5,
  failedWindowMinutes: 15,
  outsideHours: false,       // a sign-in outside the hours below (a 24/7 clinic leaves this off)
};

// Mon–Fri 07:00–19:00, Sat 07:00–14:00, Sunday any sign-in is outside hours.
const DEFAULT_HOURS = { '1-5': ['07:00', '19:00'], 6: ['07:00', '14:00'], 0: 'off' };

const DEFAULTS = {
  networks: [],
  lookupEnabled: false,
  lookupProvider: 'ipapi',
  gpsMode: 'off',
  alertsEnabled: true,
  alertChannels: { bell: true, email: true },
  rules: DEFAULT_RULES,
  hours: DEFAULT_HOURS,
  lockOutside: false,
  // On by default since 17 Oct 2026: a registered phone's pass can only check
  // in, and the tap itself needs the physical tag — phones on mobile data at
  // the entrance would otherwise be refused.
  lockTapExempt: true,
};

const FIELDS = {
  networks:       { key: K.networks,       label: 'Clinic networks' },
  lookupEnabled:  { key: K.lookupEnabled,  label: 'Look up the location of outside addresses' },
  lookupProvider: { key: K.lookupProvider, label: 'Location lookup service' },
  lookupToken:    { key: K.lookupToken,    label: 'Location lookup token' },
  gpsMode:        { key: K.gpsMode,        label: 'Ask the device for its location at sign-in' },
  alertsEnabled:  { key: K.alertsEnabled,  label: 'Suspicious sign-in alerts' },
  alertChannels:  { key: K.alertChannels,  label: 'Sign-in alert channels' },
  rules:          { key: K.rules,          label: 'When a sign-in is flagged' },
  hours:          { key: K.hours,          label: 'Expected sign-in hours' },
  lockOutside:    { key: K.lockOutside,    label: 'Network lock — only remote access outside the clinic' },
  lockTapExempt:  { key: K.lockTapExempt,  label: 'Network lock — entrance-tag phones exempt' },
};

// Lazy, as in commsConfig: a missing CARELINK_ENCRYPTION_KEY fails when the
// token is saved or used, never by crashing the API at boot.
const cryptoUtil = () => {
  if (!process.env.CARELINK_ENCRYPTION_KEY) {
    throw new Error('CARELINK_ENCRYPTION_KEY is not set — it is required to store the lookup token securely.');
  }
  return require('./crypto');
};

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearSigninSecurityCache = () => { cached = { rows: null, at: 0 }; };

const readRows = async () => {
  if (cached.rows && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const rows = await Setting.findAll({ where: { key: Object.values(K) } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cached = { rows: map, at: Date.now() };
  return map;
};

const safeParse = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const bool = (v, d) => (v === undefined || v === null || v === '' ? d : v === true || v === 'true');
const int = (v, d, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
};

/** A typed list of networks → the clean list stored, or throws with the bad entry named. */
const cleanNetworks = (value, { strict = false } = {}) => {
  const arr = safeParse(value);
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const raw = typeof item === 'string' ? item : item?.value;
    const parsed = parseNetwork(raw);
    if (!parsed) {
      if (strict) throw Object.assign(new Error(`"${String(raw || '').slice(0, 60)}" is not an IP address or range (e.g. 197.248.95.205 or 197.248.95.0/24).`), { status: 400 });
      continue;
    }
    const valueText = formatNetwork(parsed);
    if (seen.has(valueText)) continue;
    seen.add(valueText);
    const label = String((typeof item === 'object' && item?.label) || '').trim().slice(0, 60) || 'Clinic';
    out.push({ value: valueText, label });
  }
  if (out.length > 50) {
    if (strict) throw Object.assign(new Error('At most 50 clinic networks.'), { status: 400 });
    return out.slice(0, 50);
  }
  return out;
};

const cleanChannels = (value) => {
  const v = safeParse(value) || {};
  return {
    bell: typeof v.bell === 'boolean' ? v.bell : DEFAULTS.alertChannels.bell,
    email: typeof v.email === 'boolean' ? v.email : DEFAULTS.alertChannels.email,
  };
};

const cleanRules = (value) => {
  const v = safeParse(value) || {};
  const b = (name) => (typeof v[name] === 'boolean' ? v[name] : DEFAULT_RULES[name]);
  return {
    newDevice: b('newDevice'),
    newCountry: b('newCountry'),
    outsideClinic: b('outsideClinic'),
    failedAttempts: b('failedAttempts'),
    failedCount: int(v.failedCount, DEFAULT_RULES.failedCount, 2, 50),
    failedWindowMinutes: int(v.failedWindowMinutes, DEFAULT_RULES.failedWindowMinutes, 1, 1440),
    outsideHours: b('outsideHours'),
  };
};

/** Stored hours JSON → a clean { key: [start,end] | 'off' } with every weekday answered. */
const cleanHours = (value) => {
  const parsed = parseHoursDefault(safeParse(value) ?? value);
  const fallback = parseHoursDefault(DEFAULT_HOURS);
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const e = parsed[d] !== undefined ? parsed[d] : fallback[d];
    out[d] = e === 'off' ? 'off' : [e.start, e.end];
  }
  return out;
};

const getSigninSecurityConfig = async () => {
  const m = await readRows();
  let token = null;
  if (m[K.lookupToken]) {
    try { token = cryptoUtil().decrypt(m[K.lookupToken]); } catch (err) {
      console.error('SigninSecurity.decrypt error:', err.message);
    }
  }
  return {
    networks: cleanNetworks(m[K.networks]),
    lookupEnabled: bool(m[K.lookupEnabled], DEFAULTS.lookupEnabled),
    lookupProvider: PROVIDERS.includes(m[K.lookupProvider]) ? m[K.lookupProvider] : DEFAULTS.lookupProvider,
    lookupToken: token,
    gpsMode: GPS_MODES.includes(m[K.gpsMode]) ? m[K.gpsMode] : DEFAULTS.gpsMode,
    alertsEnabled: bool(m[K.alertsEnabled], DEFAULTS.alertsEnabled),
    alertChannels: cleanChannels(m[K.alertChannels]),
    rules: cleanRules(m[K.rules]),
    hours: cleanHours(m[K.hours]),
    lockOutside: bool(m[K.lockOutside], DEFAULTS.lockOutside),
    lockTapExempt: bool(m[K.lockTapExempt], DEFAULTS.lockTapExempt),
  };
};

/** The config as the settings screen may see it: the token only as set / not set. */
const redact = (cfg) => {
  const { lookupToken, ...rest } = cfg;
  return { ...rest, lookupTokenSet: !!lookupToken };
};

/**
 * Validate and write whichever fields are passed; the rest are untouched.
 * `lookupToken: ''` clears the token; leaving it out keeps it.
 */
const setSigninSecurityConfig = async (changes = {}) => {
  const write = async (key, value) => {
    const v = value == null ? '' : String(value);
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value: v } });
    if (!created && row.value !== v) await row.update({ value: v });
  };
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

  if (changes.networks !== undefined) {
    if (!Array.isArray(changes.networks)) throw bad('Clinic networks must be a list.');
    await write(K.networks, JSON.stringify(cleanNetworks(changes.networks, { strict: true })));
  }
  if (changes.lookupEnabled !== undefined) await write(K.lookupEnabled, changes.lookupEnabled === true ? 'true' : 'false');
  if (changes.lookupProvider !== undefined) {
    if (!PROVIDERS.includes(changes.lookupProvider)) throw bad('Unknown location lookup service.');
    await write(K.lookupProvider, changes.lookupProvider);
  }
  if (changes.lookupToken !== undefined) {
    const t = String(changes.lookupToken || '').trim();
    if (t.length > 200) throw bad('That token is too long.');
    await write(K.lookupToken, t ? cryptoUtil().encrypt(t) : '');
  }
  if (changes.gpsMode !== undefined) {
    if (!GPS_MODES.includes(changes.gpsMode)) throw bad("Device location must be 'off' or 'ask'.");
    await write(K.gpsMode, changes.gpsMode);
  }
  if (changes.alertsEnabled !== undefined) await write(K.alertsEnabled, changes.alertsEnabled === true ? 'true' : 'false');
  if (changes.alertChannels !== undefined) await write(K.alertChannels, JSON.stringify(cleanChannels(changes.alertChannels)));
  if (changes.rules !== undefined) await write(K.rules, JSON.stringify(cleanRules(changes.rules)));
  if (changes.hours !== undefined) {
    if (!changes.hours || typeof changes.hours !== 'object') throw bad('Sign-in hours must be set per day.');
    for (const [day, val] of Object.entries(changes.hours)) {
      if (!/^[0-6]$/.test(day)) throw bad('Sign-in hours: unknown day.');
      if (val === 'off') continue;
      if (!Array.isArray(val) || !/^\d{2}:\d{2}$/.test(val[0] || '') || !/^\d{2}:\d{2}$/.test(val[1] || '') || val[0] >= val[1]) {
        throw bad('Sign-in hours: each day needs a start before its end, or "No sign-ins expected".');
      }
    }
    await write(K.hours, JSON.stringify(cleanHours(changes.hours)));
  }
  if (changes.lockTapExempt !== undefined) await write(K.lockTapExempt, changes.lockTapExempt === true ? 'true' : 'false');
  if (changes.lockOutside !== undefined) {
    // Read what the networks are NOW (this same save may have changed them).
    clearSigninSecurityCache();
    const { networks } = await getSigninSecurityConfig();
    if (changes.lockOutside === true && networks.length === 0) {
      throw bad('Add the clinic\'s network first — with no clinic network every sign-in is outside, and the lock would shut everyone out.');
    }
    await write(K.lockOutside, changes.lockOutside === true ? 'true' : 'false');
  }
  clearSigninSecurityCache();
  const after = await getSigninSecurityConfig();
  // Removing the last clinic network switches the lock off rather than
  // leaving a lock that nobody but the remote-access holders can pass.
  if (after.lockOutside && after.networks.length === 0) {
    await write(K.lockOutside, 'false');
    clearSigninSecurityCache();
    return getSigninSecurityConfig();
  }
  return after;
};

module.exports = {
  getSigninSecurityConfig,
  setSigninSecurityConfig,
  clearSigninSecurityCache,
  redact,
  FIELDS,
  PROVIDERS,
  GPS_MODES,
  DEFAULT_RULES,
  DEFAULT_HOURS,
};
