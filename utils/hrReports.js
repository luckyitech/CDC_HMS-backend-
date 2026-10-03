// HR reports — the PURE rules (HR Tier 3 Phase 2, mockup B of hr-tier3-mockup;
// decisions T3-3 and R-1…R-8, 2 Oct 2026). No database here: services/hrReports
// loads the rows (already limited to the viewer's hr.reports scope) and asks
// these functions, so every figure on the page and in every .csv is computed
// one way.
//
// R-3 Sick leave is health data: it leaves this file only as ONE total of days
//     for the whole scope, and not at all when the scope covers fewer than
//     SICK_MIN_PEOPLE people (a small department's total would point at one
//     person). Never per person, never per department.
// R-4 Punctuality: "on time" = a gold or green check-in star (the dashboard's
//     own stars); only days with expected hours are judged.
// R-5 CPD on track: verified points ≥ target × the share of the year gone (a
//     past year: the target met). Only cadres with a target above 0.
// R-6 Expiries: everything already expired, plus what expires within the
//     window. Health documents never reach this file (the service drops them).
// R-7 Headcount: employed = not archived and Active / On Leave / Suspended
//     (a suspended person is still on the payroll); joined / left by the start
//     and end dates on the file. Departments by id; cadre by role.

const { daysUntil, isoDay } = require('./expiry');

const SICK_MIN_PEOPLE = 5;
const EXPIRY_WINDOWS = [30, 60, 90, 180];
const DEFAULT_EXPIRY_WINDOW = 90;
const EMPLOYED_STATUSES = new Set(['Active', 'On Leave', 'Suspended']);

// The headcount columns, in the order the table shows them. Every internal
// role is one of these (constants/staffRoles STAFF_ROLES).
const CADRES = [
  { key: 'doctor', label: 'Doctors' },
  { key: 'nurse',  label: 'Nurses' },
  { key: 'lab',    label: 'Lab' },
  { key: 'staff',  label: 'Front office' },
  { key: 'admin',  label: 'Admin' },
];
const cadreOf = (role) => (CADRES.some((c) => c.key === role) ? role : 'staff');

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/**
 * Is this person on the staff today (headcount)?
 * @param p { isActive, profile: { deletedAt, employmentStatus, endDate } | null }
 */
const isEmployed = (p, today) => {
  if (!p.profile) return !!p.isActive;
  if (p.profile.deletedAt) return false;
  const end = isoDay(p.profile.endDate);
  if (end && end < today) return false;
  return EMPLOYED_STATUSES.has(p.profile.employmentStatus || 'Active');
};

/** Joined / left in `year`, by the dates on the staff file. */
const movement = (people, year) => {
  const y = String(year);
  const joined = [];
  const left = [];
  for (const p of people) {
    const start = isoDay(p.profile?.startDate);
    const end = isoDay(p.profile?.endDate);
    if (start && start.startsWith(y)) joined.push({ ...p, date: start });
    if (end && end.startsWith(y)) left.push({ ...p, date: end });
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { joined: joined.sort(byDate), left: left.sort(byDate) };
};

/**
 * Department × cadre counts, with leave owed per department.
 * @param people       employed people: { role, departmentId, leaveOwed? }
 * @param departments  [{ id, name }] from the Departments list (any status)
 * @returns {{ rows, totals }}  rows sorted by name; "No department" last, only
 *          when someone in the list has none.
 */
const headcountTable = (people, departments) => {
  const blank = (id, name) => ({
    departmentId: id, name, counts: Object.fromEntries(CADRES.map((c) => [c.key, 0])), total: 0, leaveOwed: 0,
  });
  const names = new Map(departments.map((d) => [Number(d.id), d.name]));
  const rows = new Map();
  for (const p of people) {
    const id = p.departmentId ? Number(p.departmentId) : null;
    const key = id && names.has(id) ? id : null;
    if (!rows.has(key)) rows.set(key, blank(key, key ? names.get(key) : 'No department'));
    const r = rows.get(key);
    r.counts[cadreOf(p.role)] += 1;
    r.total += 1;
    r.leaveOwed = round2(r.leaveOwed + num(p.leaveOwed));
  }
  const sorted = [...rows.values()].sort((a, b) => {
    if (a.departmentId === null) return 1;
    if (b.departmentId === null) return -1;
    return a.name.localeCompare(b.name);
  });
  const totals = blank(null, 'Total');
  for (const r of sorted) {
    CADRES.forEach((c) => { totals.counts[c.key] += r.counts[c.key]; });
    totals.total += r.total;
    totals.leaveOwed = round2(totals.leaveOwed + r.leaveOwed);
  }
  return { rows: sorted, totals };
};

/**
 * One person's Annual-leave line from leaveService.summaryFor's summary.
 * Owed = what is left to take (remaining); an unlimited type owes nothing.
 */
const annualLine = (summary = [], key = 'Annual') => {
  const row = summary.find((s) => s.leaveType === key);
  if (!row) return null;
  if (row.unlimited) return { entitled: null, carriedIn: 0, taken: num(row.taken), booked: num(row.booked), remaining: null, owed: 0 };
  return {
    entitled: round2(num(row.entitled)),
    carriedIn: round2(num(row.carriedIn)),
    taken: round2(num(row.taken)),
    booked: round2(num(row.booked)),
    remaining: round2(num(row.remaining)),
    owed: round2(Math.max(0, num(row.remaining))),
  };
};

/** Days of private (sick) leave TAKEN in a person's summary. */
const privateTaken = (summary = [], privateTypes = new Set(['Sick'])) =>
  summary.filter((s) => privateTypes.has(s.leaveType)).reduce((a, s) => a + num(s.taken), 0);

/**
 * The one sick-leave figure the reports may show (R-3).
 * @param totalDays  summed across everyone in scope
 * @param people     how many people the scope covers
 */
const sickTotal = (totalDays, people, min = SICK_MIN_PEOPLE) =>
  (people < min
    ? { hidden: true, days: null, people, minimum: min }
    : { hidden: false, days: round2(totalDays), people, minimum: min });

/** Share of `year` gone by `today` (0…1): past year 1, future year 0. */
const yearElapsed = (year, today) => {
  const y = Number(year);
  const t = isoDay(today);
  const ty = Number(t.slice(0, 4));
  if (y < ty) return 1;
  if (y > ty) return 0;
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  const now = new Date(`${t}T00:00:00Z`).getTime() + 86400000;   // count today
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
};

/**
 * One person's CPD standing (R-5).
 * @param s   utils/cpd summariseCpd output { verified, pending, target, met }
 * @returns {{ ...s, expectedByNow, status: 'met'|'on_track'|'behind'|'no_target' }}
 */
const cpdStanding = (s, year, today) => {
  if (!(s.target > 0)) return { ...s, expectedByNow: 0, status: 'no_target' };
  const expectedByNow = round1(s.target * yearElapsed(year, today));
  let status = 'behind';
  if (s.verified >= s.target) status = 'met';
  else if (s.verified >= expectedByNow && yearElapsed(year, today) < 1) status = 'on_track';
  return { ...s, expectedByNow, status };
};
const onTrack = (status) => status === 'met' || status === 'on_track';

/** A clean expiry window (days), defaulting to 90. */
const cleanWindow = (v) => {
  const n = parseInt(v, 10);
  return EXPIRY_WINDOWS.includes(n) ? n : DEFAULT_EXPIRY_WINDOW;
};

/**
 * Expiry items inside the report (R-6): already expired, or expiring within
 * `window` days. Sorted soonest first.
 * @param items [{ expiryDate, ... }]
 */
const expiryRows = (items, today, window) => {
  const out = [];
  for (const it of items) {
    const daysLeft = daysUntil(it.expiryDate, today);
    if (daysLeft === null || daysLeft > window) continue;
    out.push({ ...it, expiryDate: isoDay(it.expiryDate), daysLeft, status: daysLeft < 0 ? 'expired' : 'due' });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
};

/**
 * One person's punctuality line from utils/attendanceRules monthSummary (R-4).
 * `judged` = days with a check-in star; on time = gold + green.
 */
const punctualityLine = (summary) => {
  const s = summary.stars.in;
  const t = summary.table;
  const judged = s.gold + s.green + s.red;
  const absent = summary.calendar.filter((c) => c.absent).length;
  return {
    workingDays: t.workingDays.soFar,
    daysWorked: t.workingDays.worked,
    leaveDays: t.workingDays.leave,
    judged,
    onTime: s.gold + s.green,
    late: s.red,
    onTimeRate: judged ? Math.round(((s.gold + s.green) / judged) * 100) : null,
    avgLateMinutes: t.lateCount ? Math.round(t.lateMinutesTotal / t.lateCount) : 0,
    earlyOut: t.earlyOutCount,
    missedCheckouts: t.missedCheckouts,
    noCheckIn: absent,
  };
};

/** The page's five tiles, from the built reports. */
const tiles = ({ headcount, movement: mv, leave, expiries, cpd, punctuality }) => {
  const owedPeople = leave.people.filter((p) => p.annual && p.annual.owed > 0).length;
  const judged = punctuality.people.reduce((a, p) => a + p.judged, 0);
  const onTime = punctuality.people.reduce((a, p) => a + p.onTime, 0);
  const counted = cpd.people.filter((p) => p.status !== 'no_target');
  return {
    headcount: {
      total: headcount.totals.total,
      joined: mv.joined.length,
      left: mv.left.length,
      suspended: headcount.suspended || 0,
    },
    leaveOwed: { days: headcount.totals.leaveOwed, people: owedPeople },
    expiring: {
      total: expiries.rows.length,
      expired: expiries.rows.filter((r) => r.status === 'expired').length,
      licences: expiries.rows.filter((r) => r.kind === 'licence').length,
      documents: expiries.rows.filter((r) => r.kind === 'document').length,
      window: expiries.window,
    },
    cpd: { onTrack: counted.filter((p) => onTrack(p.status)).length, of: counted.length },
    punctuality: { rate: judged ? Math.round((onTime / judged) * 100) : null, judged, onTime, month: punctuality.month },
  };
};

module.exports = {
  SICK_MIN_PEOPLE, EXPIRY_WINDOWS, DEFAULT_EXPIRY_WINDOW, EMPLOYED_STATUSES, CADRES,
  cadreOf, isEmployed, movement, headcountTable, annualLine, privateTaken, sickTotal,
  yearElapsed, cpdStanding, onTrack, cleanWindow, expiryRows, punctualityLine, tiles,
};
