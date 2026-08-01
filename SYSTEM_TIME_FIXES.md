# Dates and times — system-wide fix

**Branch:** `feat/stock-phase1` · **Date:** 2026-07-30

`utils/clinicTime.js` started as a stock fix (STK-06 in [STOCK_ISSUES.md](STOCK_ISSUES.md)).
The same confusion turned out to be everywhere, so it is now the single source for every
date and time the backend derives.

## The problem

Three different notions of "now" were in use, and they disagreed:

| Expression | What it actually gives | Where it was used |
|---|---|---|
| `new Date().toISOString().split('T')[0]` | the **UTC** date | "today" for `DATEONLY` comparisons |
| `new Date(); setHours(0,0,0,0)` | **server-local** midnight | "today" for `DATETIME` filters |
| `toLocaleTimeString('en-US', …)` | **server-local** clock | the `time` column on clinical records |

The clinic runs at UTC+03. Between **midnight and 03:00 local**, the UTC date is still
yesterday — so anything deriving "today" from `toISOString()` was a day behind for three
hours of every day.

The worst of it was clinical records pairing the two: a consultation note written at
00:30 was stored as `date: 2026-07-29` with `time: "12:30 AM"`. The record contradicts
itself, and it is filed under the wrong day.

## The fix

One module, `utils/clinicTime.js`:

| Function | Returns | For |
|---|---|---|
| `clinicToday(now?)` | `'YYYY-MM-DD'` | comparing against `DATEONLY` columns |
| `clinicDatePlusDays(n, now?)` | `'YYYY-MM-DD'` | horizons and cutoffs |
| `clinicMonthStart(monthsBack?, now?)` | `'YYYY-MM-01'` | month-bucketed reports |
| `clinicClockTime(opts?, now?)` | `'10:30 AM'` | the `time` column beside a `date` |
| `clinicMidnight('YYYY-MM-DD')` | `Date` | comparing against `DATETIME` columns |
| `clinicStartOfDay(now?)` | `Date` | the common case of the above |

Two design points worth keeping:

- **Dates stay strings.** `DATEONLY` comes back from Sequelize as `'YYYY-MM-DD'`, and
  ISO dates sort chronologically, so `a < b` is a correct date comparison with no
  timezone conversion at all. The bugs all came from leaving that string space —
  `new Date('2026-07-30')` is midnight **UTC** while `new Date(d.toDateString())` is
  midnight **local**, and comparing the two shifts by the offset.
- **`clinicClockTime` won't let you override the timezone.** Passing `timeZone` is
  ignored, because a caller reintroducing a server-local time next to a clinic date is
  precisely the bug being fixed.

Timezone comes from `CLINIC_TIMEZONE`, defaulting to `Africa/Mogadishu`.

## What changed

**Clinical records** — all five stored a UTC date beside a server-local time:
consultation notes, treatment plans, physical examinations, lab tests, initial
assessments.

**Same-day edit windows** — consultation notes and treatment plans can only be edited
on the day they were written. That window ran 03:00 → 03:00 rather than midnight →
midnight, so a note written at 01:00 was immediately uneditable while one written at
02:00 the previous night stayed editable.

**Appointments** — `?date=today`, the check-in "must be today" rule, and the stats
endpoint. Before 03:00 these matched yesterday's appointments.

**Dashboard** — `getTodayISO()` in `utils/formatters.js` now delegates to
`clinicToday()`, which fixes all five dashboard call sites at once, plus
`getDaysAgo()`. `getTodayDateRange()` uses clinic midnight.

**Queue, patients, analytics, reports, documents, blood sugar** — "today" filters,
date bucketing of `createdAt`, the future-date guard on document upload, and the
"last N days" window.

**GLP-1** — `switchDate` and `administeredDate` defaults, and `weeksSince()` in
`utils/glp1Schedule.js`, which counted milliseconds from a UTC-parsed start date to an
instant. The week number could therefore tick over up to three hours early, advancing
the dose ladder a day before the patient reached it. It now counts whole clinic days.

**Stock** — expiry, the daily sweep, FEFO, the restock plan, dashboard buckets, and the
consumption report's month columns.

### Deliberately left alone

Two places extract a calendar date *out of* a `DATEONLY` value rather than deriving
today: `appointmentController.js` (check-in comparison) and `utils/equipmentAudit.js`.
When Sequelize hands a `DATEONLY` back as a `Date` it is midnight **UTC** of that day,
so UTC extraction returns the right day and `clinicToday()` would shift it. Both now
carry a comment saying so.

## Verification

```
npm test
```

42 assertions. `tests/clinicTime.test.js` covers the helpers as pure functions, with the
cases that used to be wrong: `00:30` clinic time (when the clinic and UTC dates differ),
month/year/leap-day boundaries, and that the dose-ladder week number doesn't change with
the time of day it is asked.

## Worth knowing

**Existing rows are not migrated.** Records created between 00:00 and 03:00 before this
change carry the previous day's date. They are wrong, but they are medical records and
rewriting them is a decision for you, not a side effect of a bug fix. New records are
correct from here.

**Confirm the timezone.** `Africa/Mogadishu` matches what the server does today, so
nothing changes on the current deployment — the fixes matter the moment anything runs in
UTC (a container, a cloud host) or the clinic's timezone is anything else. Set
`CLINIC_TIMEZONE` if the default is wrong.
