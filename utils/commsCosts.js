const db = require('../models');

const { Setting } = db;

// ---------------------------------------------------------------------------
// WhatsApp cost rate card — what the clinic is charged per clinic-sent message,
// by category, with effective dates. Meta reports each message's `billable` and
// `pricingCategory`; this turns a category + date into a KES rate so the Costs
// analytics view can price a month's traffic and reconcile against Meta's
// invoice. Admin-maintained (System Settings → WhatsApp → Costs).
//
// Stored in one Setting row ('comms.rateCard') as a COMPACT positional JSON
// array — [channel, effectiveFrom(YYYY-MM-DD), service, utility, marketing,
// authentication] per row — because the shared Setting.value column is a
// VARCHAR; the compact form keeps a realistic rate card (a handful of rows)
// well within it. The API exposes/accepts readable objects; only storage is
// positional.
//
// Meta's message categories (2025+ per-message pricing): service, utility,
// marketing, authentication. Inbound (service replies inside the 24 h window)
// is free — a category with no rate returns 0.
// ---------------------------------------------------------------------------

const RATE_KEY = 'comms.rateCard';
const CATEGORIES = ['service', 'utility', 'marketing', 'authentication'];
const MAX_ROWS = 6;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0;
};

const rowToObject = (r) => ({
  channel: r[0] || 'whatsapp',
  effectiveFrom: r[1] || null,
  service: num(r[2]),
  utility: num(r[3]),
  marketing: num(r[4]),
  authentication: num(r[5]),
});

const objectToRow = (o) => [
  String(o.channel || 'whatsapp'),
  o.effectiveFrom ? String(o.effectiveFrom).slice(0, 10) : null,
  num(o.service), num(o.utility), num(o.marketing), num(o.authentication),
];

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearRateCache = () => { cached = { rows: null, at: 0 }; };

/** The rate card as an array of readable objects, newest effective date first. */
const getRateCard = async () => {
  if (!cached.rows || Date.now() - cached.at >= CACHE_MS) {
    const row = await Setting.findOne({ where: { key: RATE_KEY } });
    let arr = [];
    try { const parsed = row ? JSON.parse(row.value) : []; if (Array.isArray(parsed)) arr = parsed; } catch { arr = []; }
    cached = { rows: arr, at: Date.now() };
  }
  return cached.rows
    .map(rowToObject)
    .sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')));
};

/** Replace the whole rate card. Validates dates, categories and row count. */
const setRateCard = async (cards) => {
  if (!Array.isArray(cards)) throw new Error('Rate card must be a list of rows.');
  if (cards.length > MAX_ROWS) throw new Error(`A rate card may have at most ${MAX_ROWS} rows.`);
  for (const c of cards) {
    if (!c.effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.effectiveFrom).slice(0, 10))) {
      throw new Error('Each rate-card row needs an effective-from date (YYYY-MM-DD).');
    }
  }
  const positional = cards.map(objectToRow);
  const value = JSON.stringify(positional);
  if (value.length > 250) {
    throw new Error('Rate card is too large to store — reduce the number of rows.');
  }
  const [row, created] = await Setting.findOrCreate({ where: { key: RATE_KEY }, defaults: { key: RATE_KEY, value } });
  if (!created && row.value !== value) await row.update({ value });
  clearRateCache();
  return getRateCard();
};

/**
 * The KES rate for one billable message: the row for this channel whose
 * effectiveFrom is on or before `date` (latest such), read for `category`.
 * Unknown category or no applicable row → 0 (treated as free/unpriced).
 */
const rateFor = (rateCard, channel, category, date) => {
  const cat = CATEGORIES.includes(String(category || '').toLowerCase())
    ? String(category).toLowerCase() : null;
  if (!cat) return 0;
  const when = (date ? new Date(date) : new Date()).toISOString().slice(0, 10);
  const applicable = (rateCard || [])
    .filter((r) => (r.channel || 'whatsapp') === channel)
    .filter((r) => !r.effectiveFrom || r.effectiveFrom <= when)
    .sort((a, b) => String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')));
  return applicable.length ? num(applicable[0][cat]) : 0;
};

module.exports = { CATEGORIES, getRateCard, setRateCard, rateFor, clearRateCache };
