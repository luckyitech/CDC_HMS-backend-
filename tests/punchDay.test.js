// One session per day from every punch (fingerprint scanner, 17 Oct 2026).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildDay, decideTap } = require('../utils/punchDay');

const T = (hhmm, day = '2026-10-19') => new Date(`${day}T${hhmm}:00+03:00`);
const P = (id, hhmm, source = 'fingerprint') => ({ id, at: T(hhmm), source });
const CFG = { debounceSeconds: 120, minSessionMinutes: 10 };

describe('buildDay', () => {
  test('no punches → nothing counted', () => {
    const d = buildDay([], CFG);
    assert.equal(d.first, null);
    assert.equal(d.inside, false);
    assert.equal(d.inCount, 0);
  });

  test('one punch → checked in, still inside', () => {
    const d = buildDay([P(1, '08:31')], CFG);
    assert.equal(d.first.id, 1);
    assert.equal(d.inside, true);
    assert.equal(d.lastOut, null);
    assert.deepEqual([d.inCount, d.outCount, d.awayMinutes], [1, 0, 0]);
  });

  test('in, out, in, out → first is check-in, last is check-out, the middle gives the counters', () => {
    const d = buildDay([P(1, '08:31'), P(2, '12:40'), P(3, '13:25'), P(4, '17:05')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', 'out', 'in', 'out']);
    assert.equal(d.first.id, 1);
    assert.equal(d.lastOut.id, 4);
    assert.equal(d.inside, false);
    assert.deepEqual([d.inCount, d.outCount, d.awayMinutes], [2, 2, 45]);
  });

  test('an odd number of punches leaves the day open, with no check-out yet', () => {
    const d = buildDay([P(1, '08:00'), P(2, '12:00'), P(3, '13:00')], CFG);
    assert.equal(d.inside, true);
    assert.equal(d.lastOut, null);
    assert.equal(d.awayMinutes, 60);
  });

  test('punches arriving out of order give the same day', () => {
    const a = buildDay([P(4, '17:05'), P(2, '12:40'), P(1, '08:31'), P(3, '13:25')], CFG);
    assert.deepEqual(a.counted.map((p) => p.id), [1, 2, 3, 4]);
  });

  test('a second punch within 2 minutes is the same brush and is not counted', () => {
    const d = buildDay([P(1, '08:31'), { id: 2, at: new Date(T('08:31').getTime() + 50000), source: 'fingerprint' }, P(3, '17:00')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', null, 'out']);
  });

  test('a first "out" inside the minimum session is not counted', () => {
    const d = buildDay([P(1, '08:00'), P(2, '08:05'), P(3, '17:00')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', null, 'out']);
  });

  test('HR manual times always count, even minutes apart', () => {
    const d = buildDay([P(1, '08:00', 'manual'), P(2, '08:05', 'manual')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', 'out']);
    assert.equal(d.inside, false);
  });

  test('NFC and fingerprint punches share one day', () => {
    const d = buildDay([P(1, '08:00', 'nfc'), P(2, '17:00', 'fingerprint')], CFG);
    assert.equal(d.first.source, 'nfc');
    assert.equal(d.lastOut.source, 'fingerprint');
  });
});

describe('decideTap', () => {
  const counted = (n) => buildDay(['08:00', '12:00', '13:00', '17:00'].slice(0, n).map((h, i) => P(i + 1, h, 'nfc')), CFG).counted;
  test('first tap of the day → checkin', () => {
    assert.equal(decideTap({ now: T('08:00'), counted: [], cfg: CFG }), 'checkin');
  });
  test('inside, confirmation on → offer_checkout; with confirm → checkout', () => {
    assert.equal(decideTap({ now: T('12:00'), counted: counted(1), cfg: { ...CFG, confirmCheckout: true } }), 'offer_checkout');
    assert.equal(decideTap({ now: T('12:00'), counted: counted(1), confirm: true, cfg: { ...CFG, confirmCheckout: true } }), 'checkout');
  });
  test('confirmation off → checkout straight away', () => {
    assert.equal(decideTap({ now: T('12:00'), counted: counted(1), cfg: { ...CFG, confirmCheckout: false } }), 'checkout');
  });
  test('after an out → back_in (same session, no new day)', () => {
    assert.equal(decideTap({ now: T('13:00'), counted: counted(2), cfg: CFG }), 'back_in');
  });
  test('a confirmation pressed after the day went out → duplicate, never a check-in', () => {
    assert.equal(decideTap({ now: T('13:00'), counted: counted(2), confirm: true, cfg: CFG }), 'duplicate');
  });
  test('inside the debounce → duplicate', () => {
    assert.equal(decideTap({ now: new Date(T('12:00').getTime() + 30000), counted: counted(2), cfg: CFG }), 'duplicate');
  });
});
