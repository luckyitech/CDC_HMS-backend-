const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveExpected, parseHoursDefault, weekdayOf, datesOfMonth, previousMonth } = require('../utils/workHours');

// =====================================================================
// Precedence: dated row → weekday row (within its effective range) → clinic
// default → nothing. isOff wins at whichever level it appears.
// =====================================================================

const DEFAULTS = '{"1-5":["08:00","17:00"],"6":["08:00","13:00"],"0":"off"}';
const hhmm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

describe('parseHoursDefault', () => {
  test('expands ranges and off days', () => {
    const p = parseHoursDefault(DEFAULTS);
    assert.deepEqual(p[1], { start: '08:00', end: '17:00' });
    assert.deepEqual(p[5], { start: '08:00', end: '17:00' });
    assert.deepEqual(p[6], { start: '08:00', end: '13:00' });
    assert.equal(p[0], 'off');
  });
  test('ignores garbage without throwing', () => {
    assert.deepEqual(parseHoursDefault('not json'), {});
    assert.deepEqual(parseHoursDefault('{"7":["08:00","17:00"],"1":["17:00","08:00"],"2":"x"}'), {});
    assert.deepEqual(parseHoursDefault(null), {});
  });
});

describe('resolveExpected', () => {
  test('falls back to the clinic default (Wed 23 Sep 2026)', () => {
    const r = resolveExpected({ rows: [], clinicDate: '2026-09-23', defaults: DEFAULTS, graceDefault: 0 });
    assert.equal(r.source, 'default');
    assert.equal(r.start, '08:00'); assert.equal(r.end, '17:00');
    assert.equal(hhmm(r.startAt), '08:00'); assert.equal(hhmm(r.endAt), '17:00');
    assert.equal(r.startAt.toISOString(), '2026-09-23T05:00:00.000Z');   // 08:00 at UTC+3
    assert.equal(r.grace, 0);
  });
  test('Saturday and Sunday from the default', () => {
    assert.equal(resolveExpected({ rows: [], clinicDate: '2026-09-26', defaults: DEFAULTS }).end, '13:00');
    const sun = resolveExpected({ rows: [], clinicDate: '2026-09-27', defaults: DEFAULTS });
    assert.equal(sun.source, 'off'); assert.equal(sun.startAt, null);
  });
  test('a weekday row overrides the default and carries its own grace', () => {
    const rows = [{ weekday: 3, date: null, startTime: '07:30:00', endTime: '16:30:00', isOff: false, graceMinutes: 5, status: 'active' }];
    const r = resolveExpected({ rows, clinicDate: '2026-09-23', defaults: DEFAULTS, graceDefault: 0 });
    assert.equal(r.source, 'weekday'); assert.equal(r.start, '07:30'); assert.equal(r.end, '16:30'); assert.equal(r.grace, 5);
  });
  test('a dated row beats the weekday row', () => {
    const rows = [
      { weekday: 3, date: null, startTime: '07:30:00', endTime: '16:30:00', isOff: false, status: 'active' },
      { weekday: null, date: '2026-09-23', startTime: '10:00:00', endTime: '14:00:00', isOff: false, status: 'active' },
    ];
    const r = resolveExpected({ rows, clinicDate: '2026-09-23', defaults: DEFAULTS });
    assert.equal(r.source, 'date'); assert.equal(r.start, '10:00');
  });
  test('an off row means no expected hours', () => {
    const rows = [{ weekday: null, date: '2026-09-23', isOff: true, status: 'active' }];
    const r = resolveExpected({ rows, clinicDate: '2026-09-23', defaults: DEFAULTS });
    assert.equal(r.source, 'off'); assert.equal(r.startAt, null);
  });
  test('a retired row is ignored; an out-of-range weekday row is ignored', () => {
    const rows = [
      { weekday: 3, date: null, startTime: '07:00:00', endTime: '15:00:00', isOff: false, status: 'retired' },
      { weekday: 3, date: null, startTime: '06:00:00', endTime: '14:00:00', isOff: false, status: 'active', effectiveFrom: '2026-10-01' },
    ];
    const r = resolveExpected({ rows, clinicDate: '2026-09-23', defaults: DEFAULTS });
    assert.equal(r.source, 'default'); assert.equal(r.start, '08:00');
  });
  test('a weekday row without times takes the default times', () => {
    const rows = [{ weekday: 3, date: null, startTime: null, endTime: null, isOff: false, graceMinutes: 10, status: 'active' }];
    const r = resolveExpected({ rows, clinicDate: '2026-09-23', defaults: DEFAULTS, graceDefault: 0 });
    assert.equal(r.start, '08:00'); assert.equal(r.grace, 10); assert.equal(r.source, 'weekday');
  });
  test('no rows and no default → nothing expected', () => {
    const r = resolveExpected({ rows: [], clinicDate: '2026-09-23', defaults: '{}' });
    assert.equal(r.source, null); assert.equal(r.startAt, null);
  });
});

describe('calendar helpers', () => {
  test('weekdayOf', () => {
    assert.equal(weekdayOf('2026-09-23'), 3);   // Wednesday
    assert.equal(weekdayOf('2026-09-27'), 0);   // Sunday
  });
  test('datesOfMonth and previousMonth', () => {
    assert.equal(datesOfMonth('2026-09').length, 30);
    assert.equal(datesOfMonth('2026-02').length, 28);
    assert.equal(datesOfMonth('2028-02').length, 29);
    assert.equal(previousMonth('2026-09'), '2026-08');
    assert.equal(previousMonth('2026-01'), '2025-12');
  });
});
