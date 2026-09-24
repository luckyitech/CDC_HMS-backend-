// =====================================================================
// Time & Attendance rules (HR Suite, B21) — pure functions, no database.
//
// Everything a tap decides, everything a star means and everything the
// monthly summary counts lives here, so the controller, the sweep and the
// tests share one implementation. Dates are compared at MINUTE granularity
// (what the person sees on screen): a tap at 08:00:59 is "08:00", on time.
// =====================================================================

const { CLINIC_TZ } = require('./clinicTime');

const MINUTE = 60 * 1000;

const floorToMinute = (d) => new Date(Math.floor(new Date(d).getTime() / MINUTE) * MINUTE);

/** Whole minutes from `from` to `to` (negative when `to` is earlier). */
const minutesBetween = (from, to) =>
  Math.round((floorToMinute(to).getTime() - floorToMinute(from).getTime()) / MINUTE);

const hhmmFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: CLINIC_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
/** An instant as the clinic's wall-clock "HH:MM". */
const clinicHHMM = (d) => {
  if (!d) return null;
  const s = hhmmFormatter.format(new Date(d));
  return s === '24:00' ? '00:00' : s;
};
/** Minute of the clinic day (0..1439) for averaging times. */
const clinicMinuteOfDay = (d) => {
  const [h, m] = clinicHHMM(d).split(':').map(Number);
  return h * 60 + m;
};
const minutesToHHMM = (mins) => {
  const m = Math.round(mins);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------
// The decision table (build spec §5.3)
// ---------------------------------------------------------------------

/**
 * What a tap does, given the person's most recent session today.
 *
 * @param {object} p
 * @param {Date}   p.now
 * @param {object|null} p.lastSession  the latest non-refused, non-voided row
 *                                     for this person today (any status)
 * @param {boolean} p.confirm  the person pressed "Check out"
 * @param {object} p.cfg  { debounceSeconds, minSessionMinutes, confirmCheckout }
 * @returns {'checkin'|'offer_checkout'|'checkout'|'duplicate'}
 */
const decide = ({ now, lastSession, confirm = false, cfg }) => {
  const debounceMs = (cfg.debounceSeconds ?? 120) * 1000;
  const minSessionMs = (cfg.minSessionMinutes ?? 10) * MINUTE;
  const t = new Date(now).getTime();

  if (!lastSession) return 'checkin';

  if (lastSession.status !== 'open') {
    // A closed session: a second tap right after checking out is the same
    // brush past the tag, not a new day.
    if (lastSession.checkOutAt && t - new Date(lastSession.checkOutAt).getTime() < debounceMs) return 'duplicate';
    return 'checkin';
  }

  const sinceIn = t - new Date(lastSession.checkInAt).getTime();
  if (sinceIn < debounceMs) return 'duplicate';
  if (sinceIn < minSessionMs) return 'duplicate';
  if (cfg.confirmCheckout !== false && !confirm) return 'offer_checkout';
  return 'checkout';
};

// ---------------------------------------------------------------------
// Punctuality and stars (decision 10)
// ---------------------------------------------------------------------

/**
 * Judge one end of a session against the expected time.
 *
 * in:  before expected by ≥1 min → early; within grace after → on_time; else late.
 * out: before expected by more than grace → early; up to expected → on_time;
 *      after expected by ≥1 min → late (past working hours — the GOLD one).
 * No expected time → none.
 *
 * `minutes` is the gap the person is told: for late-in and early-out it is
 * measured after the grace band; for early-in and late-out it is the raw gap.
 */
const punctuality = ({ at, expectedAt, graceMinutes = 0, kind }) => {
  if (!expectedAt || !at) return { state: 'none', minutes: null };
  const grace = Math.max(0, Number(graceMinutes) || 0);
  const delta = minutesBetween(expectedAt, at);   // +ve = after expected
  if (kind === 'in') {
    if (delta <= -1)    return { state: 'early',   minutes: -delta };
    if (delta <= grace) return { state: 'on_time', minutes: 0 };
    return { state: 'late', minutes: delta - grace };
  }
  if (kind === 'out') {
    if (delta < -grace) return { state: 'early',   minutes: -delta - grace };
    if (delta <= 0)     return { state: 'on_time', minutes: 0 };
    return { state: 'late', minutes: delta };
  }
  throw new Error(`punctuality: unknown kind '${kind}'`);
};

/** The star a punctuality state earns. */
const starFor = (kind, state) => {
  if (kind === 'in') {
    if (state === 'early')   return 'gold';
    if (state === 'on_time') return 'green';
    if (state === 'late')    return 'red';
    return null;
  }
  if (kind === 'out') {
    if (state === 'late')    return 'gold';
    if (state === 'on_time') return 'green';
    if (state === 'early')   return 'red';
    return null;
  }
  return null;
};

// ---------------------------------------------------------------------
// Month summary and streak (dashboard + tap page)
// ---------------------------------------------------------------------

const COUNTABLE = new Set(['open', 'closed', 'missed_checkout']);

/** Sessions grouped by clinicDate, each list sorted by check-in. */
const sessionsByDay = (rows) => {
  const map = new Map();
  for (const r of rows || []) {
    if (!COUNTABLE.has(r.status)) continue;
    const list = map.get(r.clinicDate) || [];
    list.push(r);
    map.set(r.clinicDate, list);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(a.checkInAt) - new Date(b.checkInAt));
  return map;
};

/**
 * One calendar cell: the day's two stars.
 *
 * A day's in-star is its FIRST session's check-in; its out-star is its LAST
 * session's check-out. An open session (still in) or a missed check-out
 * leaves the out-star pending. A second check-in on the same day earns no
 * in-star of its own (the controller stores 'none' for it).
 */
const dayCell = (day, sessions, today) => {
  const cell = { date: day.date, in: null, out: null, leave: !!day.onLeave, off: !day.expectedStart && !day.onLeave, future: day.date > today, absent: false };
  if (cell.future) { cell.off = false; return cell; }
  if (cell.leave) return cell;
  if (!sessions || !sessions.length) {
    if (!cell.off) cell.absent = true;
    return cell;
  }
  cell.off = false;
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  cell.in = starFor('in', first.checkInPunctuality);
  if (last.status === 'closed') cell.out = starFor('out', last.checkOutPunctuality);
  else cell.out = 'pending';
  return cell;
};

const countStars = (cells) => {
  const tally = () => ({ green: 0, gold: 0, red: 0, pending: 0 });
  const stars = { in: tally(), out: tally(), all: tally() };
  for (const c of cells) {
    for (const side of ['in', 'out']) {
      const s = c[side];
      if (!s) continue;
      stars[side][s] += 1;
      stars.all[s] += 1;
    }
  }
  return stars;
};

/**
 * Consecutive working days, walking back from today, with no red star.
 * Off, leave and future days are skipped (neither break nor extend). Today
 * without a session yet is skipped. A past working day with no session at
 * all breaks the streak — an absence is not a clean day.
 *
 * @param {Array} days  [{ date, expectedStart, onLeave }] covering the range,
 *                      any order; may span months
 */
const streakNoRed = ({ days, rows, today }) => {
  const byDay = sessionsByDay(rows);
  const sorted = [...days].filter((d) => d.date <= today).sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;
  for (const day of sorted) {
    if (day.onLeave || !day.expectedStart) continue;
    const sessions = byDay.get(day.date);
    if (!sessions || !sessions.length) {
      if (day.date === today) continue;
      break;
    }
    const cell = dayCell(day, sessions, today);
    if (cell.in === 'red' || cell.out === 'red') break;
    streak += 1;
  }
  return streak;
};

/**
 * Everything the "My stars" card shows for one month.
 *
 * @param {object} p
 * @param {string} p.month   'YYYY-MM'
 * @param {Array}  p.days    one entry per calendar day of the month:
 *                           { date:'YYYY-MM-DD', expectedStart:'HH:MM'|null,
 *                             expectedEnd:'HH:MM'|null, onLeave:bool }
 * @param {Array}  p.rows    StaffAttendance rows (plain objects) for the month
 * @param {string} p.today   clinic date
 */
const monthSummary = ({ month, days, rows, today }) => {
  const byDay = sessionsByDay(rows);
  const monthDays = days.filter((d) => d.date.startsWith(month)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const calendar = monthDays.map((d) => dayCell(d, byDay.get(d.date), today));
  const stars = countStars(calendar);

  const workingDaysTotal = monthDays.filter((d) => d.expectedStart && !d.onLeave).length;
  const workingDaysSoFar = monthDays.filter((d) => d.expectedStart && !d.onLeave && d.date <= today).length;
  const leaveDays = monthDays.filter((d) => d.onLeave).length;
  const daysWorked = monthDays.filter((d) => d.date <= today && byDay.has(d.date)).length;

  let hoursWorkedMinutes = 0;
  let expectedMinutes = 0;
  let lateMinutesTotal = 0, earlyOutMinutesTotal = 0, lateCount = 0, earlyOutCount = 0, missedCheckouts = 0;
  const inMinutes = [], outMinutes = [];
  const lateDates = [], earlyOutDates = [];

  for (const day of monthDays) {
    if (day.date <= today && day.expectedStart && day.expectedEnd && !day.onLeave) {
      const [sh, sm] = day.expectedStart.split(':').map(Number);
      const [eh, em] = day.expectedEnd.split(':').map(Number);
      expectedMinutes += Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
    }
    const sessions = byDay.get(day.date);
    if (!sessions) continue;
    for (const s of sessions) {
      if (s.status === 'closed' && s.checkOutAt) {
        hoursWorkedMinutes += Math.max(0, minutesBetween(s.checkInAt, s.checkOutAt));
      }
      if (s.status === 'missed_checkout') missedCheckouts += 1;
      if (s.checkInPunctuality === 'late') { lateCount += 1; lateMinutesTotal += s.lateMinutes || 0; lateDates.push(day.date); }
      if (s.checkOutPunctuality === 'early') { earlyOutCount += 1; earlyOutMinutesTotal += s.earlyOutMinutes || 0; earlyOutDates.push(day.date); }
    }
    inMinutes.push(clinicMinuteOfDay(sessions[0].checkInAt));
    const last = sessions[sessions.length - 1];
    if (last.status === 'closed' && last.checkOutAt) outMinutes.push(clinicMinuteOfDay(last.checkOutAt));
  }

  const avg = (arr) => (arr.length ? minutesToHHMM(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

  return {
    month,
    calendar,
    stars,
    table: {
      workingDays: { worked: daysWorked, total: workingDaysTotal, soFar: workingDaysSoFar, leave: leaveDays },
      hoursWorkedMinutes,
      expectedMinutes,
      avgIn: avg(inMinutes),
      avgOut: avg(outMinutes),
      lateMinutesTotal,
      lateCount,
      lateDates,
      earlyOutMinutesTotal,
      earlyOutCount,
      earlyOutDates,
      missedCheckouts,
    },
  };
};

module.exports = {
  MINUTE,
  minutesBetween,
  clinicHHMM,
  clinicMinuteOfDay,
  minutesToHHMM,
  decide,
  punctuality,
  starFor,
  dayCell,
  sessionsByDay,
  streakNoRed,
  monthSummary,
};
