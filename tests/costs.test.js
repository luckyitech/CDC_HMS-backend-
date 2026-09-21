const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { rateFor, CATEGORIES } = require('../utils/commsCosts');

// rateFor is pure — it takes a rate card (as getRateCard returns it) and picks
// the row in effect on a date. getRateCard/setRateCard hit the DB and are
// covered by the DB harness.
const card = [
  { channel: 'whatsapp', effectiveFrom: '2026-10-01', service: 0.52, utility: 0.52, marketing: 3.22, authentication: 0.52 },
  { channel: 'whatsapp', effectiveFrom: '2026-06-01', service: 0.40, utility: 0.40, marketing: 3.00, authentication: 0.40 },
];

describe('WhatsApp cost rate card', () => {
  test('the four Meta categories are known', () => {
    assert.deepEqual([...CATEGORIES].sort(), ['authentication', 'marketing', 'service', 'utility']);
  });

  test('rateFor picks the row in effect on the date', () => {
    assert.equal(rateFor(card, 'whatsapp', 'marketing', '2026-10-15'), 3.22);
    assert.equal(rateFor(card, 'whatsapp', 'service', '2026-07-01'), 0.40);   // older row still current
  });

  test('a date before any effective row prices at zero', () => {
    assert.equal(rateFor(card, 'whatsapp', 'service', '2026-01-01'), 0);
  });

  test('an unknown category or channel prices at zero (treated as free/unpriced)', () => {
    assert.equal(rateFor(card, 'whatsapp', 'referral', '2026-10-15'), 0);
    assert.equal(rateFor(card, 'messenger', 'marketing', '2026-10-15'), 0);
  });
});
