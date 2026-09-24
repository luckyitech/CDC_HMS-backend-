// =====================================================================
// Working-hours resolver (HR Suite, B21, decision 9) — pure.
//
// Precedence for a person on a clinic date:
//   1. an active DATED row for that date (a one-day override / roster entry)
//   2. an active WEEKDAY row for that weekday whose effective range covers it
//   3. the clinic-wide default (Settings hr.hours.default)
//   4. nothing — no expected hours, no punctuality, no stars
//
// A row with isOff → 'off'. A non-off row with no times → its times come from
// the default (only its grace/override status is its own).
//
// The database read that gathers a person's rows lives in the controller
// (hrAttendanceController.expectedFor); this file only decides.
// =====================================================================

const { clinicMidnight } = require('./clinicTime');

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'YYYY-MM-DD' → weekday 0..6 (0 = Sunday), timezone-free. */
const weekdayOf = (clinicDate) => {
  const [y, m, d] = String(clinicDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/**
 * Parse the clinic default JSON. Keys are a weekday ('0'..'6') or a range
 * ('1-5'); values are ['HH:MM','HH:MM'] or 'off'. Unknown/invalid → ignored.
 * Returns { 0: {start,end}|'off'|undefined, … 6 }.
 */
const parseHoursDefault = (raw) => {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, val] of Object.entries(obj)) {
    const m = String(key).match(/^([0-6])(?:-([0-6]))?$/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    let entry;
    if (val === 'off') entry = 'off';
    else if (Array.isArray(val) && HHMM.test(val[0]) && HHMM.test(val[1]) && val[0] < val[1]) entry = { start: val[0], end: val[1] };
    else continue;
    for (let d = Math.min(from, to); d <= Math.max(from, to); d++) out[d] = entry;
  }
  return out;
};

/** 'HH:MM' on a clinic date → the instant (Date). */
const atClinicTime = (clinicDate, hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return new Date(clinicMidnight(clinicDate).getTime() + (h * 60 + m) * 60 * 1000);
};

/** TIME columns come back as 'HH:MM:SS'; normalise to 'HH:MM'. */
const toHHMM = (t) => (t ? String(t).slice(0, 5) : null);

const covers = (row, clinicDate) =>
  (!row.effectiveFrom || row.effectiveFrom <= clinicDate)
  && (!row.effectiveTo || row.effectiveTo >= clinicDate);

/**
 * @param {object} p
 * @param {Array}  p.rows        the person's StaffWorkHours rows (any status; retired are ignored)
 * @param {string} p.clinicDate  'YYYY-MM-DD'
 * @param {object|string} p.defaults  the clinic default (raw JSON string or parsed)
 * @param {number} p.graceDefault  clinic-wide grace minutes
 * @returns {{ startAt:Date|null, endAt:Date|null, start:string|null, end:string|null,
 *             grace:number, source:'date'|'weekday'|'default'|'off'|null }}
 */
const resolveExpected = ({ rows = [], clinicDate, defaults, graceDefault = 0 }) => {
  const wd = weekdayOf(clinicDate);
  const active = rows.filter((r) => r && r.status !== 'retired');
  const dated = active.find((r) => r.date && String(r.date) === clinicDate);
  const weekly = active.find((r) => r.date == null && r.weekday != null && Number(r.weekday) === wd && covers(r, clinicDate));
  const def = parseHoursDefault(defaults)[wd];

  const none = (source) => ({ startAt: null, endAt: null, start: null, end: null, grace: graceDefault, source });

  const row = dated || weekly;
  const source = dated ? 'date' : (weekly ? 'weekday' : (def ? 'default' : null));
  const grace = row && row.graceMinutes != null ? Number(row.graceMinutes) : graceDefault;

  if (row && row.isOff) return { ...none('off'), grace };

  let start = row ? toHHMM(row.startTime) : null;
  let end = row ? toHHMM(row.endTime) : null;
  if (!start || !end) {
    if (!def) return none(row ? source : null);
    if (def === 'off') return { ...none('off'), grace };
    start = def.start; end = def.end;
  }
  if (!HHMM.test(start) || !HHMM.test(end) || start >= end) return none(source);

  return {
    startAt: atClinicTime(clinicDate, start),
    endAt: atClinicTime(clinicDate, end),
    start, end, grace, source,
  };
};

/** Every calendar date of 'YYYY-MM', as 'YYYY-MM-DD' strings. */
const datesOfMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};

/** 'YYYY-MM' → the previous month. */
const previousMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

module.exports = {
  HHMM,
  weekdayOf,
  parseHoursDefault,
  atClinicTime,
  toHHMM,
  resolveExpected,
  datesOfMonth,
  previousMonth,
};
