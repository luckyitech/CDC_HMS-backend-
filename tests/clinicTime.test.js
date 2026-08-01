const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  clinicToday, clinicDatePlusDays, clinicMonthStart,
  clinicClockTime, clinicMidnight, clinicStartOfDay, CLINIC_TZ,
} = require('../utils/clinicTime');
const { getTodayISO, getDaysAgo } = require('../utils/formatters');
const { weeksSince } = require('../utils/glp1Schedule');

// =====================================================================
// Dates and times as the clinic experiences them.
//
// Pure functions, no database. The cases that matter are the ones that used
// to be wrong: the small hours, when the clinic's date and the UTC date
// disagree, and month/year boundaries.
// =====================================================================

// 00:30 on 30 July at the clinic (+03) is still 29 July in UTC. Every
// assertion below that uses this instant is testing that gap.
const SMALL_HOURS = new Date('2026-07-29T21:30:00Z');

describe('clinicToday', () => {
  test('returns YYYY-MM-DD', () => {
    assert.match(clinicToday(), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('uses the clinic day, not the UTC day, in the small hours', () => {
    assert.equal(SMALL_HOURS.toISOString().slice(0, 10), '2026-07-29', 'precondition: UTC says the 29th');
    assert.equal(clinicToday(SMALL_HOURS), '2026-07-30', 'the clinic is already on the 30th');
  });

  test('agrees with UTC during the working day', () => {
    const midday = new Date('2026-07-30T09:00:00Z');
    assert.equal(clinicToday(midday), midday.toISOString().slice(0, 10));
  });
});

describe('clinicDatePlusDays', () => {
  test('walks forwards and backwards', () => {
    assert.equal(clinicDatePlusDays(0, SMALL_HOURS), '2026-07-30');
    assert.equal(clinicDatePlusDays(1, SMALL_HOURS), '2026-07-31');
    assert.equal(clinicDatePlusDays(-1, SMALL_HOURS), '2026-07-29');
  });

  test('crosses month, year and leap-day boundaries', () => {
    assert.equal(clinicDatePlusDays(1, new Date('2026-12-31T12:00:00Z')), '2027-01-01');
    assert.equal(clinicDatePlusDays(-1, new Date('2026-03-01T12:00:00Z')), '2026-02-28');
    assert.equal(clinicDatePlusDays(1, new Date('2028-02-28T12:00:00Z')), '2028-02-29');
  });

  test('ISO date strings sort chronologically, which is why comparisons work', () => {
    assert.ok(clinicDatePlusDays(-1) < clinicToday());
    assert.ok(clinicToday() < clinicDatePlusDays(1));
  });
});

describe('clinicMonthStart', () => {
  test('gives the first of this month and of months past', () => {
    assert.equal(clinicMonthStart(0, SMALL_HOURS), '2026-07-01');
    assert.equal(clinicMonthStart(1, SMALL_HOURS), '2026-06-01');
    assert.equal(clinicMonthStart(7, SMALL_HOURS), '2025-12-01', 'crosses the year boundary');
  });

  test('a 6-month report window spans 6 distinct months', () => {
    const keys = [];
    for (let i = 5; i >= 0; i -= 1) keys.push(clinicMonthStart(i, SMALL_HOURS).slice(0, 7));
    assert.deepEqual(keys, ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    assert.equal(new Set(keys).size, 6);
  });
});

describe('clinicClockTime', () => {
  test('reports the clinic wall clock, not the server or UTC one', () => {
    assert.equal(clinicClockTime({}, SMALL_HOURS), '12:30 AM', 'half past midnight at the clinic');
  });

  test('honours format options but never the timezone', () => {
    assert.equal(
      clinicClockTime({ second: '2-digit', hour12: false }, SMALL_HOURS),
      '00:30:00'
    );
    assert.equal(
      clinicClockTime({ timeZone: 'America/New_York' }, SMALL_HOURS),
      clinicClockTime({}, SMALL_HOURS),
      'a caller must not be able to reintroduce a mixed-timezone record'
    );
  });

  test('the date and time on a record always agree', () => {
    // The bug this replaced: a UTC date beside a server-local time, giving a
    // record dated the 29th with a time of 00:30 AM for something that
    // happened on the 30th.
    assert.equal(clinicToday(SMALL_HOURS), '2026-07-30');
    assert.equal(clinicClockTime({}, SMALL_HOURS), '12:30 AM');
  });
});

describe('clinicMidnight / clinicStartOfDay', () => {
  test('midnight of a given clinic date is that date at 00:00 local', () => {
    // +03, so clinic midnight on the 30th is 21:00 UTC on the 29th.
    assert.equal(clinicMidnight('2026-07-30').toISOString(), '2026-07-29T21:00:00.000Z');
  });

  test('the instant belongs to that day, one millisecond earlier does not', () => {
    const start = clinicStartOfDay();
    assert.equal(clinicToday(start), clinicToday());
    assert.equal(clinicToday(new Date(start.getTime() - 1)), clinicDatePlusDays(-1));
  });

  test('a day is exactly 24 hours in a zone without DST', () => {
    const a = clinicMidnight('2026-07-30');
    const b = clinicMidnight('2026-07-31');
    assert.equal(b - a, 24 * 60 * 60 * 1000);
  });
});

describe('formatters delegate to the clinic clock', () => {
  test('getTodayISO is the clinic date', () => {
    assert.equal(getTodayISO(), clinicToday());
  });

  test('getDaysAgo counts clinic days', () => {
    assert.equal(getDaysAgo(7), clinicDatePlusDays(-7));
    assert.equal(getDaysAgo(0), clinicToday());
  });
});

describe('GLP-1 dose ladder counts whole clinic days', () => {
  test('week 0 covers the first seven days', () => {
    const start = '2026-07-01';
    assert.equal(weeksSince(start, new Date('2026-07-01T09:00:00Z')), 0);
    assert.equal(weeksSince(start, new Date('2026-07-07T09:00:00Z')), 0, 'day 6 is still week 0');
    assert.equal(weeksSince(start, new Date('2026-07-08T09:00:00Z')), 1, 'day 7 begins week 1');
  });

  test('the answer does not depend on the time of day it is asked', () => {
    const start = '2026-07-01';
    const early = weeksSince(start, new Date('2026-07-08T21:30:00Z')); // 00:30 on the 9th, clinic
    const late = weeksSince(start, new Date('2026-07-09T18:00:00Z'));  // 21:00 on the 9th, clinic
    assert.equal(early, late, 'week number must be stable across a clinic day');
  });

  test('a future start date has no elapsed weeks, and a missing one is null', () => {
    assert.equal(weeksSince(clinicDatePlusDays(7)), null);
    assert.equal(weeksSince(null), null);
    assert.equal(weeksSince(''), null);
  });
});

describe('configuration', () => {
  test('the clinic timezone is explicit, not inherited from the server', () => {
    assert.equal(CLINIC_TZ, process.env.CLINIC_TIMEZONE || 'Africa/Mogadishu');
  });
});
