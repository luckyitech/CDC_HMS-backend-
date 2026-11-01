// =====================================================================
// One session per person per clinic day, built from every punch
// (HR Suite — fingerprint scanner, 17 Oct 2026, Emu's decisions; restored
// 1 Nov 2026 after the 19 Oct first-in/last-out model, now with the time out
// taken off the hours).
//
// Pure functions, no database. Every punch of the day — NFC tap,
// fingerprint, card or an HR manual time — is kept. The FIRST counted punch
// is the check-in; the punches after it alternate out, in, out… and the day
// is checked out while its last counted punch is an "out". Lateness, early
// leaving and stars are judged on the first in and the last out only; the
// ones in between give the counters (ins, outs, time away), and the hours
// are the time inside (workedMinutes).
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
 *   workedMinutes: number,   time inside (complete in → out pairs only)
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
  // Time inside (1 Nov 2026, Emu: time out comes off the hours): every
  // complete in → out pair. A last "in" with no "out" adds nothing — the
  // hours stop at the last out and the day shows Missed check-out until HR
  // adds the missing punch.
  const inside = counted.length % 2 === 1;
  const { workedMinutes } = hoursOf(counted, counted[0]?.at, !inside && counted.length ? counted[counted.length - 1].at : null);
  return {
    punches: all,
    counted,
    first: counted[0] || null,
    lastOut: !inside && counted.length ? counted[counted.length - 1] : null,
    inside,
    inCount: Math.ceil(counted.length / 2),
    outCount: Math.floor(counted.length / 2),
    awayMinutes,
    workedMinutes,
  };
};

/**
 * The hours of a day (1 Nov 2026, Emu: time out comes off the hours), for a
 * window from `startAt` (the check-in) to `endAt` (the check-out — or, while
 * there is none, the last counted "out": a missed check-out counts to the
 * last out). Time out = every gap from an "out" to the next "in", clipped to
 * the window, so punches before or after times HR set do not count.
 * @returns {{ awayMinutes:number, workedMinutes:number }}
 */
const hoursOf = (counted, startAt, endAt) => {
  if (!startAt) return { awayMinutes: 0, workedMinutes: 0 };
  const start = new Date(startAt).getTime();
  let end = endAt ? new Date(endAt).getTime() : null;
  if (end == null) {
    const outs = (counted || []).filter((p) => p.direction === 'out' && new Date(p.at).getTime() > start);
    end = outs.length ? new Date(outs[outs.length - 1].at).getTime() : null;
  }
  if (end == null || end <= start) return { awayMinutes: 0, workedMinutes: 0 };
  let awayMs = 0;
  const list = counted || [];
  for (let i = 0; i + 1 < list.length; i += 1) {
    if (list[i].direction !== 'out' || list[i + 1].direction !== 'in') continue;
    const a = Math.max(start, new Date(list[i].at).getTime());
    const b = Math.min(end, new Date(list[i + 1].at).getTime());
    if (b > a) awayMs += b - a;
  }
  const awayMinutes = Math.round(awayMs / MINUTE);
  return { awayMinutes, workedMinutes: Math.max(0, Math.round((end - start) / MINUTE) - awayMinutes) };
};

// ---------------------------------------------------------------------
// The 19 Oct 2026 model (first punch in, last punch out, the rest not
// read). Days already built under it keep it when they are rebuilt — a link
// made later or a late relay batch must not re-read an old day
// (services/punchService modelOf). New days use the alternating model above.
// ---------------------------------------------------------------------
const nextDirectionFirstLast = (counted, at, cfg, source = null) => {
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
const buildDayFirstLast = (punches, cfg = {}) => {
  const sorted = [...(punches || [])].sort(byTime);
  const all = sorted.map((p) => ({ ...p, direction: null }));
  let first = null;
  let lastOut = null;
  for (const row of all) {
    const counted = first ? (lastOut ? [first, lastOut] : [first]) : [];
    const direction = nextDirectionFirstLast(counted, row.at, cfg, row.source);
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
 * What an NFC tap does now (replaces the old one-session-per-tap decide()).
 *
 * @returns {'checkin'|'back_in'|'offer_checkout'|'checkout'|'duplicate'}
 *   checkin        the day's first punch
 *   back_in        an "in" after an "out" (no star of its own)
 *   offer_checkout an "out" that needs the person to press Check out
 *   checkout       an "out"
 *   duplicate      not counted — nothing is written
 */
const decideTap = ({ now, counted, confirm = false, cfg = {}, model = 2 }) => {
  // A day still on the 19 Oct model (built before 1 Nov) is read with it.
  const direction = (model === 1 ? nextDirectionFirstLast : nextDirection)(counted || [], now, cfg);
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

module.exports = { buildDay, buildDayFirstLast, hoursOf, decideTap, nextDirection, methodOf, verificationOf };
