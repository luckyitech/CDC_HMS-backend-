const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildTapMessages, titleFor } = require('../utils/tapMessages');

// The copy table is a contract with the signed-off mockup; these pin the
// lines that were agreed word for word.
const now = new Date('2026-09-23T09:01:00+03:00');
const doctor = { firstName: 'Ebrahim', role: 'doctor' };
const nurse = { firstName: 'Amina', role: 'nurse' };
const session = { checkInAt: new Date('2026-09-23T08:04:00+03:00'), expectedInAt: new Date('2026-09-23T08:00:00+03:00'), expectedOutAt: new Date('2026-09-23T17:00:00+03:00') };

describe('buildTapMessages', () => {
  test('"Dr" for doctors only', () => {
    assert.equal(titleFor(doctor), 'Dr');
    assert.equal(titleFor(nurse), '');
  });
  test('on-time check-in', () => {
    const m = buildTapMessages({ action: 'checked_in', user: doctor, session, punct: { state: 'on_time', minutes: 0 }, now: new Date('2026-09-23T08:04:00+03:00') });
    assert.equal(m.headline, 'Checked in, 08:04');
    assert.equal(m.mood, '👍 Right on time. Have a good day, Dr Ebrahim.');
    assert.deepEqual(m.facts, [['Reporting time today', '08:00']]);
  });
  test('early check-in with a streak', () => {
    const m = buildTapMessages({ action: 'checked_in', user: nurse, session, punct: { state: 'early', minutes: 15 }, month: { streakNoRed: 14 }, now });
    assert.equal(m.mood, "🎉✨ You're 15 minutes early!! ✨🎉");
    assert.equal(m.sub, '14 days in a row without a red star — thank you, Amina.');
  });
  test('late check-in — the gentle line and the facts', () => {
    const m = buildTapMessages({ action: 'checked_in', user: doctor, session, punct: { state: 'late', minutes: 61 }, month: { lateCount: 3 }, now });
    assert.equal(m.headline, 'Checked in, 09:01');
    assert.equal(m.mood, "😔 You're 61 minutes late.");
    assert.equal(m.sub, 'Tomorrow will be better! 🌅');
    assert.deepEqual(m.facts, [['Required reporting time today', '08:00'], ['Check-in time', '09:01'], ['Late check-ins this month', '3 (Sep)']]);
  });
  test('positiveFeedback off drops the mood lines but keeps the facts', () => {
    const m = buildTapMessages({ action: 'checked_in', user: doctor, session, punct: { state: 'early', minutes: 5 }, now, positiveFeedback: false });
    assert.equal(m.mood, null); assert.equal(m.sub, null); assert.equal(m.facts.length, 1);
  });
  test('offer to check out, on time', () => {
    const m = buildTapMessages({ action: 'offer_checkout', user: doctor, session, punct: { state: 'on_time', minutes: 0 }, now: new Date('2026-09-23T16:55:00+03:00') });
    assert.equal(m.headline, 'Check out?');
    assert.equal(m.sub, "You've been in since 08:04 — 8 h 51 m.");
  });
  test('offer to check out early', () => {
    const m = buildTapMessages({ action: 'offer_checkout', user: doctor, session, punct: { state: 'early', minutes: 40 }, month: { earlyOutCount: 1 }, now: new Date('2026-09-23T16:20:00+03:00') });
    assert.equal(m.headline, 'Check out early?');
    assert.deepEqual(m.facts, [['Your day ends at', '17:00'], ["It's now", '16:20 · 40 min early'], ['Early check-outs this month', '1 (Sep)']]);
  });
  test('checked out past hours — gold', () => {
    const m = buildTapMessages({ action: 'checked_out', user: nurse, session, punct: { state: 'late', minutes: 40 }, now: new Date('2026-09-23T17:40:00+03:00') });
    assert.equal(m.mood, '🌟 40 minutes past your hours — thank you, Amina.');
  });
  test('duplicate and refused', () => {
    assert.equal(buildTapMessages({ action: 'duplicate', user: doctor, session, now, duplicateSide: 'in' }).sub, 'You checked in a minute ago at 08:04.');
    const r = buildTapMessages({ action: 'refused', user: doctor, now });
    assert.equal(r.headline, "This tap can't be verified");
  });
});
