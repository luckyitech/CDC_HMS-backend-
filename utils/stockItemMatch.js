// =====================================================================
// Matching an invoice line to a stock item (13 Oct 2026, Emu). Pure functions:
// no database, so they are unit-tested and the controller stays thin.
//
//   1. Remembered — the supplier has used this wording before
//      (StockSupplierAliases): the match is certain.
//   2. Suggested  — the closest catalogue name by wording; staff confirm, and
//      the two next-closest are offered under it.
//   3. Unmatched  — nothing close enough; staff pick an item or add a new one.
// =====================================================================

// Supplier shorthand → the words the catalogue uses. Applied to both sides,
// so "TABS" and "tab" meet in the middle.
const SYNONYMS = {
  TABS: 'TAB', TABLET: 'TAB', TABLETS: 'TAB', TBS: 'TAB',
  CAPS: 'CAP', CAPSULE: 'CAP', CAPSULES: 'CAP',
  INJ: 'INJECTION', INJS: 'INJECTION',
  STRP: 'STRIP', STRPS: 'STRIP', STRIPS: 'STRIP',
  SOLN: 'SOLUTION', SUSP: 'SUSPENSION', SYR: 'SYRUP',
  AMP: 'AMPOULE', AMPS: 'AMPOULE', AMPOULES: 'AMPOULE',
  VIALS: 'VIAL', PENS: 'PEN', NEEDLES: 'NEEDLE', SYRINGES: 'SYRINGE',
  CARTRIDGES: 'CARTRIDGE', CART: 'CARTRIDGE',
  MCG: 'MCG', UG: 'MCG', IU: 'IU', U: 'IU', UNITS: 'IU',
  MLS: 'ML', GM: 'G', GMS: 'G', GRAMS: 'G', GRAM: 'G',
  INSULIN: 'INSULIN', INS: 'INSULIN',
  GLUC: 'GLUCOSE', BG: 'GLUCOSE',
};
// Pack-count suffixes ("50S", "100'S", "X10") say how many, not what — dropped.
const PACK_WORD = /^(\d+)'?S$/;
const STOP = new Set(['OF', 'THE', 'AND', 'X', 'PK', 'PACK', 'BOX', 'PCS', 'PC', 'EA', 'EACH', 'NO', 'NOS']);

/** "Metformin 500mg Tabs 10x10" → ["METFORMIN", "500", "MG", "TAB"] */
const tokens = (text) => {
  const up = String(text || '').toUpperCase()
    .replace(/\b\d+\s*X\s*\d+\b/g, ' ')         // 10X10, 2 x 50 — pack arithmetic, not the product
    .replace(/\b\d+'?S\b/g, ' ')                 // 50S, 100'S — a pack count, not the product
    .replace(/(\d)([A-Z]+)/g, '$1 $2')        // 500MG → 500 MG, 4MM → 4 MM
    .replace(/([A-Z])(\d)/g, '$1 $2')         // ML10 → ML 10
    .replace(/[^A-Z0-9.]+/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1_$2');         // keep 0.5 together
  return up.split(/\s+/)
    .map((t) => t.replace(/\./g, '').replace('_', '.'))
    .filter((t) => t && !STOP.has(t) && !PACK_WORD.test(t) && !/^\d+X\d+$/.test(t))
    .map((t) => SYNONYMS[t] || t);
};

/** The lookup key for StockSupplierAliases: wording with the noise out. */
const aliasKeyOf = (text) => tokens(text).join(' ').slice(0, 160);

const bigrams = (s) => {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
};
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return (2 * n) / (a.size + b.size);
};

/**
 * 0–1: how alike two product wordings are. Token overlap carries most of the
 * weight (a strength like "500 MG" is a token on both sides); character
 * bigrams catch spelling variants ("Empagliflozin" / "Empaglifozin").
 */
const similarity = (a, b) => {
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta); const sb = new Set(tb);
  const tokenScore = dice(sa, sb);
  // A strength on both sides that differs ("500 MG" vs "850 MG") is a different product.
  const nums = (t) => t.filter((x) => /^\d/.test(x));
  const na = nums(ta); const nb = nums(tb);
  const numberClash = na.length && nb.length && !na.some((x) => nb.includes(x));
  const charScore = dice(bigrams(ta.join(' ')), bigrams(tb.join(' ')));
  const score = 0.65 * tokenScore + 0.35 * charScore;
  return numberClash ? score * 0.5 : score;
};

const SUGGEST_MIN = 0.42;

/**
 * Match one invoice wording against the catalogue.
 *   items:   [{ id, name, status }]  (retired items are skipped)
 *   aliases: Map(aliasKey → stockItemId) for this supplier
 * → { status: 'remembered'|'suggested'|'unmatched', stockItemId, candidates: [{ stockItemId, name, score }] }
 */
const matchLine = (text, items, aliases = new Map()) => {
  const live = items.filter((i) => i.status !== 'retired');
  const byId = new Map(live.map((i) => [i.id, i]));
  const key = aliasKeyOf(text);
  const scored = live
    .map((i) => ({ stockItemId: i.id, name: i.name, score: Number(similarity(text, i.name).toFixed(3)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const remembered = key && aliases.get(key);
  if (remembered && byId.has(remembered)) {
    return {
      status: 'remembered', stockItemId: remembered,
      candidates: scored.filter((c) => c.stockItemId !== remembered).slice(0, 2),
    };
  }
  if (scored.length && scored[0].score >= SUGGEST_MIN) {
    return { status: 'suggested', stockItemId: scored[0].stockItemId, candidates: scored };
  }
  return { status: 'unmatched', stockItemId: null, candidates: scored };
};

module.exports = { tokens, aliasKeyOf, similarity, matchLine, SUGGEST_MIN };
