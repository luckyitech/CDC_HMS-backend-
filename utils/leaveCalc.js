// Counting leave — what a date range costs, day by day.
//
// B27 (HR Suite phase 2, spec claude/hr-leave-and-my-profile-build-spec.md §5).
// Pure: no database, no clock. Everything the answer depends on is passed in,
// so the same inputs always give the same breakdown and the tests can pin
// every rule the clinic set:
//
//   - HR sets the VALUE of each weekday (1 / ½ / 0). Saturday may be a full
//     day by clinic policy; Sunday is usually 0. (Decision D3, Emu 27 Sep.)
//   - Mode 'clinic_week': everyone is charged by that one week.
//     Mode 'own_hours':   a day the person is not expected in (their own HR
//                         hours) costs 0; a day they are costs the weekday value.
//   - A per-person override week, when set, beats both.
//   - A public holiday is never counted. (D3/D4.)
//   - Half days: the first day may start in the afternoon ('pm'), the last may
//     end at lunch ('am'). A half day costs half that day's value.
//   - Calendar-day types (Maternity and Paternity by law) count EVERY day as 1,
//     holidays included — the breakdown still flags the holiday so the screen
//     can say so.
//
// The primitives (UTC date parsing, ranges) stay in utils/leaveDays.js and are
// re-exported here, so older imports keep working and there is one parser.

const { toUtcDate, datesInRange, rangesOverlap, countLeaveDays } = require('./leaveDays');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Mon–Sat full, Sunday off — the D1 starting point the draft policies are
// seeded with. HR edits it; nothing reads this when a policy is supplied.
const DEFAULT_WEEK_WEIGHTS = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };

// How far past the end we look for the day back at work. Longer than any run
// of non-working days a real week can produce (a holiday block + a weekend).
const RETURN_SEARCH_DAYS = 60;

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * MS_PER_DAY);
const round2 = (n) => Math.round(n * 100) / 100;

const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(toUtcDate(value).getTime())
  && iso(toUtcDate(value)) === value;   // rejects 2026-02-30

/** A weight is a number between 0 and 1. Anything else reads as 0. */
const weightOf = (weights, weekday) => {
  if (!weights) return 0;
  const raw = weights[weekday] ?? weights[String(weekday)];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1, n);
};

/** Holidays arrive as a Map(date → name), an object, or an array of dates / {date, name}. */
const toHolidayMap = (holidays) => {
  if (!holidays) return new Map();
  if (holidays instanceof Map) return holidays;
  if (Array.isArray(holidays)) {
    return new Map(holidays.map((h) => (typeof h === 'string' ? [h, 'Public holiday'] : [h.date, h.name || 'Public holiday'])));
  }
  if (typeof holidays === 'object') return new Map(Object.entries(holidays));
  return new Map();
};

const labelFor = (d) => `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;

/**
 * What one date costs.
 *
 * @returns {{ value: number, reason: 'holiday'|'off'|'short'|'working', holiday?: string }}
 *   reason 'short' = a part day by policy (e.g. Saturday worth ½).
 */
const dayValue = (date, {
  weekWeights = DEFAULT_WEEK_WEIGHTS, mode = 'clinic_week', personWeek = null, expectedFor = null, holidays = null,
} = {}) => {
  const d = toUtcDate(date);
  const key = iso(d);
  const weekday = d.getUTCDay();
  const hol = toHolidayMap(holidays);

  if (hol.has(key)) return { value: 0, reason: 'holiday', holiday: hol.get(key) };

  let value;
  if (personWeek) {
    value = weightOf(personWeek, weekday);
  } else if (mode === 'own_hours' && typeof expectedFor === 'function') {
    value = expectedFor(key) ? weightOf(weekWeights, weekday) : 0;
  } else {
    value = weightOf(weekWeights, weekday);
  }

  if (value === 0) return { value: 0, reason: 'off' };
  if (value < 1) return { value, reason: 'short' };
  return { value, reason: 'working' };
};

/**
 * Groups consecutive days that cost the same for the same reason, for the
 * calculator screen: "Mon 7 – Fri 11 Sep · 5".
 */
const groupBreakdown = (days) => {
  const groups = [];
  for (const day of days) {
    const last = groups[groups.length - 1];
    const same = last && last.value === day.value && last.reason === day.reason
      && last.holiday === day.holiday && !day.half && !last.half
      && iso(addDays(toUtcDate(last.to), 1)) === day.date;
    if (same) {
      last.to = day.date;
      last.days += 1;
      last.subtotal = round2(last.subtotal + day.charged);
      last.label = `${labelFor(toUtcDate(last.from))} – ${labelFor(toUtcDate(last.to))}`;
    } else {
      groups.push({
        from: day.date, to: day.date, days: 1, value: day.value, reason: day.reason,
        holiday: day.holiday, half: day.half || null, subtotal: day.charged, label: day.label,
      });
    }
  }
  return groups;
};

/**
 * What a whole request costs.
 *
 * @param {object} args
 * @param {string} args.start       YYYY-MM-DD
 * @param {string} args.end         YYYY-MM-DD
 * @param {'full'|'pm'} [args.startPart]  'pm' = starts after lunch (first day is a half)
 * @param {'full'|'am'} [args.endPart]    'am' = back after lunch on the last day
 * @param {'working'|'calendar'} [args.countedAs]
 *   + everything dayValue() takes (weekWeights, mode, personWeek, expectedFor, holidays)
 * @returns {{ ok: boolean, error?: string, total: number, days: object[], groups: object[],
 *             returnDate: string|null, returnPart: 'full'|'pm'|null, holidaysInRange: object[] }}
 */
const countLeave = ({ start, end, startPart = 'full', endPart = 'full', countedAs = 'working', ...opts } = {}) => {
  const empty = (error) => ({ ok: false, error, total: 0, days: [], groups: [], returnDate: null, returnPart: null, holidaysInRange: [] });

  if (!isIsoDate(start) || !isIsoDate(end)) return empty('BAD_DATE');
  if (!['full', 'pm'].includes(startPart) || !['full', 'am'].includes(endPart)) return empty('BAD_PART');
  if (!['working', 'calendar'].includes(countedAs)) return empty('BAD_COUNTING');

  const s = toUtcDate(start);
  const e = toUtcDate(end);
  if (e < s) return empty('END_BEFORE_START');
  // One day that starts after lunch AND ends at lunch is no time at all.
  if (start === end && startPart === 'pm' && endPart === 'am') return empty('BAD_PART');

  const hol = toHolidayMap(opts.holidays);
  const days = [];
  for (let d = s; d <= e; d = addDays(d, 1)) {
    const key = iso(d);
    const base = countedAs === 'calendar'
      ? { value: 1, reason: 'calendar', ...(hol.has(key) ? { holiday: hol.get(key) } : {}) }
      : dayValue(key, { ...opts, holidays: hol });

    let half = null;
    if (key === start && startPart === 'pm') half = 'pm';
    if (key === end && endPart === 'am') half = half ? null : 'am';   // both on one day: already refused above
    const charged = round2(half ? base.value * 0.5 : base.value);

    days.push({ date: key, label: labelFor(d), ...base, half, charged });
  }

  const total = round2(days.reduce((sum, d) => sum + d.charged, 0));

  // Back at work: the same afternoon when the last day ends at lunch;
  // otherwise the first following day that is worth anything.
  let returnDate = null;
  let returnPart = null;
  if (endPart === 'am') {
    returnDate = end;
    returnPart = 'pm';
  } else {
    for (let i = 1, d = addDays(e, 1); i <= RETURN_SEARCH_DAYS; i += 1, d = addDays(d, 1)) {
      if (dayValue(iso(d), { ...opts, holidays: hol }).value > 0) {
        returnDate = iso(d);
        returnPart = 'full';
        break;
      }
    }
  }

  const holidaysInRange = days.filter((d) => d.holiday).map((d) => ({ date: d.date, name: d.holiday }));

  return { ok: true, total, days, groups: groupBreakdown(days), returnDate, returnPart, holidaysInRange };
};

/** Validates a week-weights object: seven weekdays, each 0, 0.5 or 1. */
const validWeekWeights = (weights) => {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return false;
  for (let wd = 0; wd <= 6; wd += 1) {
    const v = weights[wd] ?? weights[String(wd)];
    if (![0, 0.5, 1].includes(Number(v))) return false;
  }
  return Object.keys(weights).every((k) => /^[0-6]$/.test(k));
};

/**
 * The day a holiday that falls on a Sunday is observed (HR Tier 2; Kenya's
 * Public Holidays Act: the next following day that is not itself a public
 * holiday). → 'YYYY-MM-DD', or null when the date is not a Sunday.
 * e.g. Christmas on a Sunday: Boxing Day is Monday, so Christmas is observed Tuesday.
 *
 * @param {string} date               the holiday, YYYY-MM-DD
 * @param {Set<string>} holidayDates  every active holiday date
 */
const observedDayFor = (date, holidayDates = new Set()) => {
  const d = toUtcDate(date);
  if (!d || d.getUTCDay() !== 0) return null;
  const next = new Date(d.getTime());
  for (let i = 0; i < 14; i += 1) {
    next.setUTCDate(next.getUTCDate() + 1);
    const iso = next.toISOString().slice(0, 10);
    if (!holidayDates.has(iso)) return iso;
  }
  return null;
};

module.exports = {
  DEFAULT_WEEK_WEIGHTS,
  observedDayFor,
  dayValue,
  countLeave,
  groupBreakdown,
  validWeekWeights,
  isIsoDate,
  toHolidayMap,
  // Primitives, re-exported so there is one parser and old imports keep working.
  toUtcDate,
  datesInRange,
  rangesOverlap,
  countLeaveDays,
};
