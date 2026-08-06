const db = require('../models');
const {
  SETTINGS,
  DEFAULT_STANDARD_VAT_BP,
  CURRENCY,
} = require('../constants/billing');

const { Setting } = db;

// =====================================================================
// Clinic-wide billing configuration — VAT rate, whether prices are quoted
// inclusive, and the identity printed on a tax invoice.
//
// Lives in the Settings table rather than .env because the people who need to
// change it are the clinic admin and their accountant, not whoever can restart
// the server. A VAT rate change or a corrected KRA PIN must not require a
// deploy.
//
// Same shape as utils/passwordRotation.js's getRotationConfig: one cached read,
// one write path that invalidates the cache.
// =====================================================================

const CACHE_TTL_MS = 60 * 1000;
let cached = { config: null, at: 0 };

// ---------------------------------------------------------------------
// One field spec drives reading, defaulting, validating and writing. Adding a
// setting is a row here — not a new branch in three functions that then drift
// apart.
// ---------------------------------------------------------------------
const asInt = (raw) => {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) ? n : null;
};

const asBool = (raw) => (raw === 'true' ? true : raw === 'false' ? false : null);

const asText = (raw) => {
  const trimmed = String(raw ?? '').trim();
  return trimmed || null;
};

const FIELDS = {
  // Kenya's standard VAT rate in basis points. Only ever applied to service
  // items classed 'standard' — see vatRateBpFor in constants/billing.js.
  standardVatBp: {
    key: SETTINGS.STANDARD_VAT_BP,
    fallback: DEFAULT_STANDARD_VAT_BP,
    parse: asInt,
    serialize: String,
    validate: (v) => (Number.isInteger(v) && v >= 0 && v <= 10000
      ? null
      : 'VAT rate must be between 0 and 10000 basis points (0–100%)'),
  },

  // Whether the price list is quoted VAT-INCLUSIVE. True is the Kenyan retail
  // convention and the default. Every invoice snapshots this at issue, so
  // flipping it changes what new prices mean without reinterpreting old bills.
  pricesIncludeVat: {
    key: SETTINGS.PRICES_INCLUDE_VAT,
    fallback: true,
    parse: asBool,
    serialize: (v) => (v ? 'true' : 'false'),
    validate: (v) => (typeof v === 'boolean' ? null : 'pricesIncludeVat must be true or false'),
  },

  // Whether the clinic is VAT-registered at all. If it is not, VAT is never
  // charged and eTIMS does not apply — the module still invoices and takes
  // payments, it just has no tax layer to report.
  vatRegistered: {
    key: SETTINGS.VAT_REGISTERED,
    fallback: false,
    parse: asBool,
    serialize: (v) => (v ? 'true' : 'false'),
    validate: (v) => (typeof v === 'boolean' ? null : 'vatRegistered must be true or false'),
  },

  clinicName: {
    key: SETTINGS.CLINIC_NAME,
    fallback: null,
    parse: asText,
    serialize: String,
    validate: () => null,
  },

  // The KRA PIN printed on a tax invoice: a letter, nine digits, a letter
  // (P051234567X). Validated loosely — a wrong-format PIN is a typo worth
  // catching, but this is not the authority on what KRA will accept.
  clinicPin: {
    key: SETTINGS.CLINIC_PIN,
    fallback: null,
    parse: asText,
    serialize: (v) => String(v).toUpperCase(),
    validate: (v) => (v === null || /^[A-Z]\d{9}[A-Z]$/i.test(v)
      ? null
      : 'KRA PIN should be a letter, nine digits and a letter (e.g. P051234567X)'),
  },

  clinicAddress: {
    key: SETTINGS.CLINIC_ADDRESS,
    fallback: null,
    parse: asText,
    serialize: String,
    validate: () => null,
  },
};

const FIELD_NAMES = Object.keys(FIELDS);
const SETTING_KEYS = FIELD_NAMES.map((name) => FIELDS[name].key);

const defaults = () => {
  const config = { currency: CURRENCY };
  FIELD_NAMES.forEach((name) => { config[name] = FIELDS[name].fallback; });
  return config;
};

/**
 * The clinic's billing configuration, cached for a minute.
 *
 * On a read failure this returns DEFAULTS rather than throwing. Refusing to
 * bill anyone because a settings lookup blipped is the worse outcome, and the
 * defaults are safe: every seeded service is VAT-exempt, so the standard rate
 * is unused until an admin deliberately classes something 'standard'. The
 * effective rate is snapshotted onto every invoice line regardless, so a bill
 * raised during a blip still records exactly what it charged.
 */
const getBillingConfig = async () => {
  if (cached.config && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config;
  try {
    const rows = await Setting.findAll({ where: { key: SETTING_KEYS } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    config = { currency: CURRENCY };
    FIELD_NAMES.forEach((name) => {
      const field = FIELDS[name];
      const stored = byKey.get(field.key);
      const parsed = stored === undefined ? null : field.parse(stored);
      // A stored value that no longer parses (hand-edited row, type changed)
      // falls back rather than poisoning the config with null.
      config[name] = parsed === null ? field.fallback : parsed;
    });
  } catch (err) {
    console.error('Billing config read failed — using defaults:', err.message);
    return defaults();
  }

  cached = { config, at: Date.now() };
  return config;
};

/**
 * Update one or more settings. Unknown keys are ignored rather than stored, so
 * a typo cannot create a setting that looks live and is never read — the same
 * rule sanitizePermissions applies to permission names.
 *
 * Returns { config } on success or { errors } if any value was rejected;
 * nothing is written unless every value passes.
 */
const setBillingConfig = async (patch = {}) => {
  const changes = [];
  const errors = [];

  FIELD_NAMES.forEach((name) => {
    if (!(name in patch)) return;
    const field = FIELDS[name];
    const value = patch[name];

    // Clearing an optional text field is a legitimate edit.
    const normalised = value === null || value === '' ? null : value;
    const message = field.validate(normalised);
    if (message) {
      errors.push(message);
      return;
    }
    changes.push({ key: field.key, value: normalised === null ? '' : field.serialize(normalised) });
  });

  if (errors.length) return { errors };

  for (const { key, value } of changes) {
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value } });
    if (!created) await row.update({ value });
  }

  clearBillingConfigCache();
  return { config: await getBillingConfig() };
};

/** Drops the cache. For tests and for any path that writes a Setting directly. */
const clearBillingConfigCache = () => { cached = { config: null, at: 0 }; };

module.exports = {
  getBillingConfig,
  setBillingConfig,
  clearBillingConfigCache,
  BILLING_SETTING_KEYS: SETTING_KEYS,
};
