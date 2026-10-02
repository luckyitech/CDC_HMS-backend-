// Expiry maths — pure, no database. Shared by the My-profile to-do list
// (B27 phase 4) and the daily expiry-reminder job (phase 5, decision D12).
//
// One place decides "how many days until this expires" and "which reminder is
// due", so the to-do and the reminder never disagree about whether a licence or
// a document is expiring.
//
// The reminder rule (Emu, 29 Sep 2026): remind at 60 / 30 / 7 / 0 days before
// expiry, then STOP — no nagging after it has expired; it stays on the person's
// to-do list until they renew it.

const DAY_MS = 86400000;

// A YYYY-MM-DD day from a DATEONLY string, a datetime string, or a Date object
// (licence expiry is a DATE column and arrives as a Date). Null if unusable.
const isoDay = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Whole days from `today` to `date` (both YYYY-MM-DD, a datetime, or a Date). Null if unusable. */
const daysUntil = (date, today) => {
  const dDay = isoDay(date);
  const tDay = isoDay(today);
  if (!dDay || !tDay) return null;
  const d = new Date(`${dDay}T00:00:00Z`).getTime();
  const t = new Date(`${tDay}T00:00:00Z`).getTime();
  if (Number.isNaN(d) || Number.isNaN(t)) return null;
  return Math.round((d - t) / DAY_MS);
};

/**
 * Which reminder threshold is due for something `daysLeft` days from expiry, or
 * null. Fires the SMALLEST configured threshold that is still ≥ daysLeft, so as
 * the date approaches each milestone (60 → 30 → 7 → 0) fires once — the caller
 * de-duplicates per (item, threshold, expiry date). Nothing fires once it has
 * expired (daysLeft < 0), and nothing fires while it is further off than the
 * largest threshold.
 *
 * Robust to a missed day: at daysLeft 28 the "30" bucket is still returned (30
 * ≥ 28), so a job that did not run exactly on day 30 still sends the 30-day
 * reminder — and the "60" it already sent is held back by de-duplication.
 */
const dueThreshold = (daysLeft, thresholds = DEFAULT_THRESHOLDS) => {
  if (daysLeft === null || daysLeft === undefined || daysLeft < 0) return null;
  const candidates = [...thresholds]
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= 0 && t >= daysLeft);
  if (!candidates.length) return null;
  return Math.min(...candidates);
};

// The clinic default, mirrored in the frontend and the HR settings default.
const DEFAULT_THRESHOLDS = [60, 30, 7, 0];

/** A clean, de-duplicated, descending threshold list (for validating a settings write). */
const cleanThresholds = (list) => {
  if (!Array.isArray(list)) return null;
  const set = new Set(
    list.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 3650),
  );
  if (!set.size) return null;
  return [...set].sort((a, b) => b - a);
};

module.exports = { daysUntil, dueThreshold, cleanThresholds, isoDay, DEFAULT_THRESHOLDS };
