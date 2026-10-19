// One session per day from every punch (fingerprint scanner, 17 Oct 2026;
// simplified 19 Oct 2026: first punch in, last punch out, the rest kept).
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
    assert.deepEqual(d.counted, []);
  });

  test('one punch → checked in, still inside', () => {
    const d = buildDay([P(1, '08:31')], CFG);
    assert.equal(d.first.id, 1);
    assert.equal(d.inside, true);
    assert.equal(d.lastOut, null);
  });

  test('four punches → first is the check-in, last is the check-out, the two between are kept with no direction', () => {
    const d = buildDay([P(1, '08:31'), P(2, '12:40'), P(3, '13:25'), P(4, '17:05')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', null, null, 'out']);
    assert.equal(d.first.id, 1);
    assert.equal(d.lastOut.id, 4);
    assert.equal(d.inside, false);
    assert.deepEqual(d.counted.map((p) => p.id), [1, 4]);
  });

  test('three punches → the third is the check-out (a later punch moves the check-out)', () => {
    const d = buildDay([P(1, '08:00'), P(2, '12:00'), P(3, '13:00')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', null, 'out']);
    assert.equal(d.inside, false);
    assert.equal(d.lastOut.id, 3);
  });

  test('punches arriving out of order give the same day', () => {
    const a = buildDay([P(4, '17:05'), P(2, '12:40'), P(1, '08:31'), P(3, '13:25')], CFG);
    assert.deepEqual(a.counted.map((p) => p.id), [1, 4]);
  });

  test('a second punch within the minimum session of the check-in is not a check-out', () => {
    const d = buildDay([P(1, '08:31'), { id: 2, at: new Date(T('08:31').getTime() + 50000), source: 'fingerprint' }, P(3, '17:00')], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', null, 'out']);
    const e = buildDay([P(1, '08:00'), P(2, '08:05')], CFG);
    assert.equal(e.inside, true);
  });

  test('a second punch within 2 minutes of the check-out does not move it', () => {
    const d = buildDay([P(1, '08:00'), P(2, '17:00'), { id: 3, at: new Date(T('17:00').getTime() + 40000), source: 'fingerprint' }], CFG);
    assert.deepEqual(d.punches.map((p) => p.direction), ['in', 'out', null]);
    assert.equal(d.lastOut.id, 2);
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
  const counted = (n) => buildDay(['08:00', '12:00'].slice(0, n).map((h, i) => P(i + 1, h, 'nfc')), CFG).counted;
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
  test('after a check-out, a later tap is another check-out (it moves the check-out), never a check-in', () => {
    assert.equal(decideTap({ now: T('13:00'), counted: counted(2), cfg: { ...CFG, confirmCheckout: false } }), 'checkout');
    assert.equal(decideTap({ now: T('13:00'), counted: counted(2), cfg: CFG }), 'offer_checkout');
  });
  test('a confirmation pressed on a day with no check-in → duplicate, never a check-in', () => {
    assert.equal(decideTap({ now: T('13:00'), counted: [], confirm: true, cfg: CFG }), 'duplicate');
  });
  test('inside the debounce of the check-out, or the minimum session of the check-in → duplicate', () => {
    assert.equal(decideTap({ now: new Date(T('12:00').getTime() + 30000), counted: counted(2), cfg: CFG }), 'duplicate');
    assert.equal(decideTap({ now: T('08:05'), counted: counted(1), cfg: CFG }), 'duplicate');
  });
});
