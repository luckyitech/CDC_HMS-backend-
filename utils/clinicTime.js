// =====================================================================
// One definition of "now" for the whole system.
//
// Dates a human would recognise — the date on a consultation note, the day a
// dose was given, whether a batch has expired — are the CLINIC's dates, not
// the server's and not UTC's. Every one of them should come from here.
//
// Two failure modes this exists to prevent, both of which were live:
//
//   1. UTC dates. `new Date().toISOString().slice(0, 10)` is the UTC date. At
//      +03 that is yesterday between midnight and 03:00, so a note written at
//      01:00 was filed under the previous day — and the same-day edit rule
//      then let it be edited until 03:00 the following morning.
//
//   2. Mixed frames. Those same records paired that UTC date with a
//      toLocaleTimeString() in SERVER-local time, producing a record that
//      contradicts itself: date 2026-07-29 with time "01:00 AM" for something
//      that happened at 01:00 on the 30th.
//
// DATEONLY columns come back from Sequelize as plain 'YYYY-MM-DD' strings, and
// ISO dates sort lexicographically, so `a < b` on two of them is a correct date
// comparison with no timezone conversion at all. Everything below stays in that
// string space; only the two functions that must produce an instant for a
// DATETIME comparison leave it.
// =====================================================================

// The clinic's wall-clock timezone. Override with CLINIC_TIMEZONE if the clinic
// moves or a second site opens; the default matches where the clinic operates,
// so behaviour no longer depends on how the server happens to be configured.
const CLINIC_TZ = process.env.CLINIC_TIMEZONE || 'Africa/Mogadishu';

// 'en-CA' formats as YYYY-MM-DD, which is the format we want to compare in.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Today's date at the clinic, as 'YYYY-MM-DD'.
const clinicToday = (now = new Date()) => formatter.format(now);

// A date offset from today at the clinic, as 'YYYY-MM-DD'. Used for expiry
// horizons ("expiring within 30 days"). Day arithmetic is done in UTC on a
// noon anchor so a DST transition can't push it onto the wrong day.
const clinicDatePlusDays = (days, now = new Date()) => {
  const [y, m, d] = clinicToday(now).split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
};

// The first of the month, `monthsBack` calendar months ago, as 'YYYY-MM-DD'.
// Drives month-bucketed reports.
const clinicMonthStart = (monthsBack = 0, now = new Date()) => {
  const [y, m] = clinicToday(now).split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1 - monthsBack, 1, 12));
  return `${anchor.toISOString().slice(0, 8)}01`;
};

// The clinic's wall-clock time, for the `time` column that sits beside a `date`
// on clinical records. Defaults to the "10:30 AM" shape those columns already
// use; pass Intl options to vary it. The timeZone is not overridable — pairing
// a clinic date with a server-local time is the bug this file exists to stop.
const clinicClockTime = (options = {}, now = new Date()) =>
  now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...options,
    timeZone: CLINIC_TZ,
  });

// How far the clinic's wall clock is ahead of UTC at a given instant, in ms.
const offsetMsAt = (date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CLINIC_TZ,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  // Read the clinic's wall clock as if it were UTC; the gap is the offset.
  const asIfUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second
  );
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
};

// The instant a given clinic date ('YYYY-MM-DD') began — for comparing against
// DATETIME columns like createdAt, which are timestamps rather than date
// strings and so can't use the string comparisons above.
const clinicMidnight = (clinicDate) => {
  const [y, m, d] = String(clinicDate).split('-').map(Number);
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  // Apply the offset, then re-measure at the result: one refinement settles the
  // case where a DST boundary sits between the two. (Africa/Mogadishu has no
  // DST, so this is future-proofing for a CLINIC_TIMEZONE override.)
  const first = new Date(midnightAsUtc - offsetMsAt(new Date(midnightAsUtc)));
  return new Date(midnightAsUtc - offsetMsAt(first));
};

// The instant today began at the clinic. The common case of clinicMidnight —
// "today's" queue, "today's" registrations, "today's" movements.
const clinicStartOfDay = (now = new Date()) => clinicMidnight(clinicToday(now));

// The calendar day after a given clinic date, as 'YYYY-MM-DD'.
//
// For half-open date ranges: "everything on or before the 6th" is
// `< clinicMidnight(nextClinicDate('2026-08-06'))`, which includes the whole of
// the 6th. Writing it as `<= clinicMidnight('2026-08-06')` instead silently
// drops every row after midnight — that is, the entire day.
//
// Pure calendar arithmetic in UTC, so it never touches a timezone: Date.UTC
// normalises the 32nd of a month into the 1st of the next.
const nextClinicDate = (clinicDate) => {
  const [y, m, d] = String(clinicDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

module.exports = {
  clinicToday,
  clinicDatePlusDays,
  clinicMonthStart,
  clinicClockTime,
  clinicMidnight,
  clinicStartOfDay,
  nextClinicDate,
  CLINIC_TZ,
};
