const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { dayValue, countLeave, validWeekWeights, DEFAULT_WEEK_WEIGHTS } = require('../utils/leaveCalc');

// B27 — counting leave (spec §5). Dates below are real 2026 dates:
// Mon 7 Sep … Sun 13 Sep; Mashujaa Day is Tue 20 Oct 2026.

const SAT_FULL = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
const SAT_HALF = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0.5 };
const MON_FRI = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0 };
const HOLIDAYS = [{ date: '2026-10-20', name: 'Mashujaa Day' }, { date: '2026-10-10', name: 'Mazingira Day' }];

describe('what one day costs', () => {
  test('a weekday is worth the value HR gave it', () => {
    assert.deepEqual(dayValue('2026-09-07', { weekWeights: SAT_FULL }), { value: 1, reason: 'working' });
  });
  test('Saturday can be a FULL day by clinic policy', () => {
    assert.equal(dayValue('2026-09-12', { weekWeights: SAT_FULL }).value, 1);
  });
  test('…or half a day', () => {
    assert.deepEqual(dayValue('2026-09-12', { weekWeights: SAT_HALF }), { value: 0.5, reason: 'short' });
  });
  test('Sunday worth 0 is a day off', () => {
    assert.deepEqual(dayValue('2026-09-13', { weekWeights: SAT_FULL }), { value: 0, reason: 'off' });
  });
  test('a public holiday is never counted, whatever the weekday is worth', () => {
    assert.deepEqual(dayValue('2026-10-20', { weekWeights: SAT_FULL, holidays: HOLIDAYS }),
      { value: 0, reason: 'holiday', holiday: 'Mashujaa Day' });
  });
  test('own-hours mode: a day the person is not expected in costs nothing', () => {
    const expectedFor = (d) => d !== '2026-09-09';   // their Wednesday off
    assert.equal(dayValue('2026-09-09', { weekWeights: SAT_FULL, mode: 'own_hours', expectedFor }).value, 0);
    assert.equal(dayValue('2026-09-10', { weekWeights: SAT_FULL, mode: 'own_hours', expectedFor }).value, 1);
  });
  test('a per-person override week beats the clinic week and own hours', () => {
    const personWeek = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0 };   // Mon–Wed only
    assert.equal(dayValue('2026-09-10', { weekWeights: SAT_FULL, personWeek }).value, 0);
    assert.equal(dayValue('2026-09-07', { weekWeights: SAT_FULL, personWeek, mode: 'own_hours', expectedFor: () => false }).value, 1);
  });
  test('…but a holiday still beats the override', () => {
    const personWeek = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
    assert.equal(dayValue('2026-10-20', { personWeek, holidays: HOLIDAYS }).value, 0);
  });
});

describe('what a request costs', () => {
  test('Mon–Fri is 5, not 4 (inclusive)', () => {
    const r = countLeave({ start: '2026-09-07', end: '2026-09-11', weekWeights: MON_FRI });
    assert.equal(r.ok, true);
    assert.equal(r.total, 5);
  });
  test('Mon–Sun with Saturday worth 1 is 6', () => {
    assert.equal(countLeave({ start: '2026-09-07', end: '2026-09-13', weekWeights: SAT_FULL }).total, 6);
  });
  test('Mon–Sun with Saturday worth ½ is 5.5', () => {
    assert.equal(countLeave({ start: '2026-09-07', end: '2026-09-13', weekWeights: SAT_HALF }).total, 5.5);
  });
  test('a holiday inside the range is not charged and is named', () => {
    const r = countLeave({ start: '2026-10-19', end: '2026-10-23', weekWeights: MON_FRI, holidays: HOLIDAYS });
    assert.equal(r.total, 4);
    assert.deepEqual(r.holidaysInRange, [{ date: '2026-10-20', name: 'Mashujaa Day' }]);
  });
  test('half days at both ends: starts after lunch Mon, back after lunch Fri', () => {
    const r = countLeave({ start: '2026-09-07', end: '2026-09-11', startPart: 'pm', endPart: 'am', weekWeights: MON_FRI });
    assert.equal(r.total, 4);
    assert.equal(r.returnDate, '2026-09-11');
    assert.equal(r.returnPart, 'pm');
  });
  test('a single half day', () => {
    assert.equal(countLeave({ start: '2026-09-08', end: '2026-09-08', endPart: 'am', weekWeights: MON_FRI }).total, 0.5);
    assert.equal(countLeave({ start: '2026-09-08', end: '2026-09-08', startPart: 'pm', weekWeights: MON_FRI }).total, 0.5);
  });
  test('a half of a half-value Saturday is a quarter', () => {
    assert.equal(countLeave({ start: '2026-09-12', end: '2026-09-12', startPart: 'pm', weekWeights: SAT_HALF }).total, 0.25);
  });
  test('the return date skips the weekend and a holiday', () => {
    // Fri 16 Oct → Mon 19 Oct is a working day, so back Monday…
    assert.equal(countLeave({ start: '2026-10-12', end: '2026-10-16', weekWeights: MON_FRI, holidays: HOLIDAYS }).returnDate, '2026-10-19');
    // …ending Mon 19 Oct: Tue 20 is Mashujaa Day, so back Wednesday.
    assert.equal(countLeave({ start: '2026-10-19', end: '2026-10-19', weekWeights: MON_FRI, holidays: HOLIDAYS }).returnDate, '2026-10-21');
  });
  test('calendar-day types (maternity) count every day, holidays included, and still flag them', () => {
    const r = countLeave({ start: '2026-10-19', end: '2026-10-25', countedAs: 'calendar', weekWeights: MON_FRI, holidays: HOLIDAYS });
    assert.equal(r.total, 7);
    assert.deepEqual(r.holidaysInRange, [{ date: '2026-10-20', name: 'Mashujaa Day' }]);
  });
  test('the breakdown groups consecutive identical days', () => {
    const r = countLeave({ start: '2026-09-07', end: '2026-09-13', weekWeights: SAT_HALF });
    assert.deepEqual(r.groups.map((g) => [g.from, g.to, g.subtotal, g.reason]), [
      ['2026-09-07', '2026-09-11', 5, 'working'],
      ['2026-09-12', '2026-09-12', 0.5, 'short'],
      ['2026-09-13', '2026-09-13', 0, 'off'],
    ]);
    assert.equal(r.groups[0].label, 'Mon 7 Sep – Fri 11 Sep');
  });
  test('refuses a reversed range, a bad date and an impossible half day', () => {
    assert.equal(countLeave({ start: '2026-09-11', end: '2026-09-07' }).error, 'END_BEFORE_START');
    assert.equal(countLeave({ start: '2026-02-30', end: '2026-03-02' }).error, 'BAD_DATE');
    assert.equal(countLeave({ start: '2026-09-08', end: '2026-09-08', startPart: 'pm', endPart: 'am' }).error, 'BAD_PART');
  });
  test('own-hours mode with a day off in the range', () => {
    const expectedFor = (d) => d !== '2026-09-09';
    const r = countLeave({ start: '2026-09-07', end: '2026-09-11', mode: 'own_hours', expectedFor, weekWeights: SAT_FULL });
    assert.equal(r.total, 4);
  });
  test('the default week is Mon–Sat full, Sunday off', () => {
    assert.equal(countLeave({ start: '2026-09-07', end: '2026-09-13' }).total, 6);
    assert.deepEqual(DEFAULT_WEEK_WEIGHTS, SAT_FULL);
  });
});

describe('week weights HR can save', () => {
  test('seven weekdays, each 0, ½ or 1', () => {
    assert.equal(validWeekWeights(SAT_HALF), true);
    assert.equal(validWeekWeights({ ...SAT_HALF, 6: 0.3 }), false);
    assert.equal(validWeekWeights({ 1: 1 }), false);
    assert.equal(validWeekWeights({ ...SAT_HALF, 7: 1 }), false);
  });
});
