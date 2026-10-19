// =====================================================================
// One session per person per clinic day, built from every punch
// (HR Suite — fingerprint scanner, 17 Oct 2026; simplified 19 Oct 2026,
// Emu's decision: first punch is the check-in, last punch is the check-out,
// anything between is kept but not interpreted).
//
// Pure functions, no database. Every punch of the day — NFC tap,
// fingerprint, card or an HR manual time — is kept. The FIRST punch is the
// check-in. The LAST punch that lands at least the minimum session after it
// is the check-out; a later punch moves the check-out later. Punches in
// between stay on record with no direction. Lateness, early leaving and
// stars are judged on those two punches only.
//
// A punch is not counted (direction null) when it is within the minimum
// session of the check-in (the same brush past the tag or the scanner, or a
// second scan at the door), or within the debounce of the check-out it would
// replace. Both limits come from the check-in rules (utils/hrConfig). A time
// HR entered by hand (source 'manual') always counts.
// =====================================================================

const { MINUTE } = require('./attendanceRules');

const byTime = (a, b) => (new Date(a.at) - new Date(b.at)) || ((a.id || 0) - (b.id || 0));

const limitsOf = (cfg = {}) => ({
  debounceMs: (cfg.debounceSeconds ?? 120) * 1000,
  minSessionMs: (cfg.minSessionMinutes ?? 10) * MINUTE,
});

/**
 * Would a punch at `at` count, given the day so far? `counted` is the
 * check-in and, when there is one, the current check-out.
 * Returns 'in' | 'out' | null (not counted).
 */
const nextDirection = (counted, at, cfg, source = null) => {
  const { debounceMs, minSessionMs } = limitsOf(cfg);
  if (!counted.length) return 'in';
  if (source === 'manual') return 'out';
  const t = new Date(at).getTime();
  if (t - new Date(counted[0].at).getTime() < minSessionMs) return null;
  const last = counted[counted.length - 1];
  if (counted.length > 1 && t - new Date(last.at).getTime() < debounceMs) return null;
  return 'out';
};

/**
 * The day, from its punches (any order).
 *
 * @param {Array}  punches  [{ id, at, source, ... }]
 * @param {object} cfg      { debounceSeconds, minSessionMinutes }
 * @returns {{
 *   punches: Array,          every punch, sorted, each with `direction` ('in'|'out'|null)
 *   counted: Array,          [check-in] or [check-in, check-out]
 *   first: object|null,      the check-in punch
 *   lastOut: object|null,    the check-out punch, null while the day is still in
 *   inside: boolean,         checked in, not yet out
 * }}
 */
const buildDay = (punches, cfg = {}) => {
  const sorted = [...(punches || [])].sort(byTime);
  const all = sorted.map((p) => ({ ...p, direction: null }));
  let first = null;
  let lastOut = null;
  for (const row of all) {
    const counted = first ? (lastOut ? [first, lastOut] : [first]) : [];
    const direction = nextDirection(counted, row.at, cfg, row.source);
    if (direction === 'in') { first = row; row.direction = 'in'; }
    else if (direction === 'out') {
      if (lastOut) lastOut.direction = null;   // a later punch moves the check-out
      lastOut = row; row.direction = 'out';
    }
  }
  return {
    punches: all,
    counted: first ? (lastOut ? [first, lastOut] : [first]) : [],
    first,
    lastOut,
    inside: !!first && !lastOut,
  };
};

/**
 * What an NFC tap does now.
 *
 * @returns {'checkin'|'offer_checkout'|'checkout'|'duplicate'}
 *   checkin        the day's first punch
 *   offer_checkout an "out" that needs the person to press Check out
 *   checkout       an "out" (a later one moves the check-out)
 *   duplicate      not counted — nothing is written
 */
const decideTap = ({ now, counted, confirm = false, cfg = {} }) => {
  const direction = nextDirection(counted || [], now, cfg);
  if (!direction) return 'duplicate';
  // "Check out" was pressed on a day that has no check-in any more (HR
  // voided it meanwhile): never turn the confirmation into a check-in.
  if (confirm && direction !== 'out') return 'duplicate';
  if (direction === 'in') return 'checkin';
  if (cfg.confirmCheckout !== false && !confirm) return 'offer_checkout';
  return 'checkout';
};

/** The session method for a punch source. */
const METHOD_OF_SOURCE = { nfc: 'nfc', fingerprint: 'fingerprint', card: 'card', manual: 'manual' };
const methodOf = (source) => METHOD_OF_SOURCE[source] || 'manual';
const verificationOf = (source) => (source === 'manual' ? 'manual' : 'verified');

module.exports = { buildDay, decideTap, nextDirection, methodOf, verificationOf };
