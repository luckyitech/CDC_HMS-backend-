const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { daysUntil, dueThreshold, cleanThresholds, DEFAULT_THRESHOLDS } = require('../utils/expiry');

describe('expiry — daysUntil', () => {
  test('counts whole days forward and back', () => {
    assert.equal(daysUntil('2026-10-10', '2026-10-01'), 9);
    assert.equal(daysUntil('2026-10-01', '2026-10-01'), 0);
    assert.equal(daysUntil('2026-09-20', '2026-10-01'), -11);
  });
  test('accepts a Date and a datetime string', () => {
    assert.equal(daysUntil(new Date('2026-10-08T00:00:00Z'), '2026-10-01'), 7);
    assert.equal(daysUntil('2026-10-08T12:34:56Z', '2026-10-01'), 7);
  });
  test('null date or bad input → null', () => {
    assert.equal(daysUntil(null, '2026-10-01'), null);
    assert.equal(daysUntil('', '2026-10-01'), null);
    assert.equal(daysUntil('not-a-date', '2026-10-01'), null);
  });
});

describe('expiry — dueThreshold', () => {
  const T = DEFAULT_THRESHOLDS; // [60,30,7,0]
  test('fires the smallest threshold still >= daysLeft', () => {
    assert.equal(dueThreshold(60, T), 60);
    assert.equal(dueThreshold(45, T), 60);   // crossed into the <=60 window
    assert.equal(dueThreshold(30, T), 30);
    assert.equal(dueThreshold(28, T), 30);   // missed-day robustness
    assert.equal(dueThreshold(7, T), 7);
    assert.equal(dueThreshold(3, T), 7);
    assert.equal(dueThreshold(0, T), 0);     // on the day
  });
  test('nothing once expired (no nagging after expiry)', () => {
    assert.equal(dueThreshold(-1, T), null);
    assert.equal(dueThreshold(-30, T), null);
  });
  test('nothing while further off than the largest threshold', () => {
    assert.equal(dueThreshold(61, T), null);
    assert.equal(dueThreshold(100, T), null);
  });
  test('null daysLeft → null', () => {
    assert.equal(dueThreshold(null, T), null);
  });
  test('honours a custom threshold list without 0', () => {
    assert.equal(dueThreshold(0, [60, 30, 7]), 7); // expiry day falls to the 7 bucket
    assert.equal(dueThreshold(5, [60, 30, 7]), 7);
    assert.equal(dueThreshold(-1, [60, 30, 7]), null);
  });
});

describe('expiry — cleanThresholds', () => {
  test('de-dups, sorts descending, drops junk', () => {
    assert.deepEqual(cleanThresholds([7, 60, 30, 7, 0]), [60, 30, 7, 0]);
    assert.deepEqual(cleanThresholds([30, -5, 3.5, 'x', 30]), [30]);
  });
  test('empty or non-array → null', () => {
    assert.equal(cleanThresholds([]), null);
    assert.equal(cleanThresholds('nope'), null);
    assert.equal(cleanThresholds([-1, 4000]), null);
  });
});
