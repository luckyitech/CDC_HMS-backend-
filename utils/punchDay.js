// =====================================================================
// One session per person per clinic day, built from every punch
// (HR Suite — fingerprint scanner, 17 Oct 2026, Emu's decisions).
//
// Pure functions, no database. Every punch of the day — NFC tap,
// fingerprint, card or an HR manual time — is kept. The FIRST counted punch
// is the check-in; the punches after it alternate out, in, out… and the day
// is checked out while its last counted punch is an "out". Lateness, early
// leaving and stars are judged on the first in and the last out only; the
// ones in between give the counters (ins, outs, time away).
//
// A punch is not counted (direction null) when it lands inside the debounce
// of the previous counted punch (the same brush past the tag or the scanner),
// or when it would be the first "out" less than the minimum session after the
// check-in. Both come from the existing check-in rules (utils/hrConfig).
// =====================================================================

const { MINUTE, minutesBetween } = require('./attendanceRules');

const byTime = (a, b) => (new Date(a.at) - new Date(b.at)) || ((a.id || 0) - (b.id || 0));

const limitsOf = (cfg = {}) => ({
  debounceMs: (cfg.debounceSeconds ?? 120) * 1000,
  minSessionMs: (cfg.minSessionMinutes ?? 10) * MINUTE,
});

/**
 * Would a punch at `at` count, given the punches already counted (sorted)?
 * Returns 'in' | 'out' | null (not counted). A time HR entered by hand
 * (source 'manual') always counts: the debounce is for brushes past a tag
 * or the scanner, not for HR's own entries.
 */
const nextDirection = (counted, at, cfg, source = null) => {
  const { debounceMs, minSessionMs } = limitsOf(cfg);
  if (!counted.length) return 'in';
  if (source === 'manual') return counted.length % 2 === 1 ? 'out' : 'in';
  const t = new Date(at).getTime();
  const last = counted[counted.length - 1];
  if (t - new Date(last.at).getTime() < debounceMs) return null;
  if (counted.length === 1 && t - new Date(counted[0].at).getTime() < minSessionMs) return null;
  return counted.length % 2 === 1 ? 'out' : 'in';
};

/**
 * The day, from its punches (any order).
 *
 * @param {Array}  punches  [{ id, at, source, ... }]
 * @param {object} cfg      { debounceSeconds, minSessionMinutes }
 * @returns {{
 *   punches: Array,          every punch, sorted, each with `direction` ('in'|'out'|null)
 *   counted: Array,          the counted ones only
 *   first: object|null,      the check-in punch
 *   lastOut: object|null,    the check-out punch while the day is checked out, else null
 *   inside: boolean,         an odd number of counted punches: still in
 *   inCount: number, outCount: number, awayMinutes: number,
 * }}
 */
const buildDay = (punches, cfg = {}) => {
  const sorted = [...(punches || [])].sort(byTime);
  const counted = [];
  const all = sorted.map((p) => {
    const direction = nextDirection(counted, p.at, cfg, p.source);
    const row = { ...p, direction };
    if (direction) counted.push(row);
    return row;
  });
  let awayMinutes = 0;
  for (let i = 1; i + 1 < counted.length; i += 2) {
    awayMinutes += Math.max(0, minutesBetween(counted[i].at, counted[i + 1].at));
  }
  const inside = counted.length % 2 === 1;
  return {
    punches: all,
    counted,
    first: counted[0] || null,
    lastOut: !inside && counted.length ? counted[counted.length - 1] : null,
    inside,
    inCount: Math.ceil(counted.length / 2),
    outCount: Math.floor(counted.length / 2),
    awayMinutes,
  };
};

/**
 * What an NFC tap does now (replaces the old one-session-per-tap decide()).
 *
 * @returns {'checkin'|'back_in'|'offer_checkout'|'checkout'|'duplicate'}
 *   checkin        the day's first punch
 *   back_in        an "in" after an "out" (no star of its own)
 *   offer_checkout an "out" that needs the person to press Check out
 *   checkout       an "out"
 *   duplicate      not counted — nothing is written
 */
const decideTap = ({ now, counted, confirm = false, cfg = {} }) => {
  const direction = nextDirection(counted || [], now, cfg);
  if (!direction) return 'duplicate';
  // "Check out" was pressed, but the day is no longer in (a fingerprint "out"
  // landed meanwhile): never turn the confirmation into a check-in.
  if (confirm && direction !== 'out') return 'duplicate';
  if (direction === 'in') return counted && counted.length ? 'back_in' : 'checkin';
  if (cfg.confirmCheckout !== false && !confirm) return 'offer_checkout';
  return 'checkout';
};

/** The session method for a punch source. */
const METHOD_OF_SOURCE = { nfc: 'nfc', fingerprint: 'fingerprint', card: 'card', manual: 'manual' };
const methodOf = (source) => METHOD_OF_SOURCE[source] || 'manual';
const verificationOf = (source) => (source === 'manual' ? 'manual' : 'verified');

module.exports = { buildDay, decideTap, nextDirection, methodOf, verificationOf };
