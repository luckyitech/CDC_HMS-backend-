const test = require('node:test');
const assert = require('node:assert');
const { summariseExpiry } = require('../utils/expiryReport');

const item = { id: 1, name: 'Ozempic 1 mg pen', unit: 'pen', category: 'medication' };
const batch = (id, expiryDate, qtyReceived) => ({ id, expiryDate, qtyReceived, labelCode: `STK-${id}`, item });
const today = '2026-10-13';

test('status and quantities per batch', () => {
  const { batches } = summariseExpiry({
    today,
    batches: [batch(1, '2026-09-30', 10), batch(2, '2026-10-05', 6), batch(3, '2026-11-20', 8), batch(4, '2026-08-01', 5)],
    levels: [
      { stockBatchId: 2, quantity: 4, locationName: 'Fridge' },
      { stockBatchId: 3, quantity: 5, locationName: 'Fridge' },
      { stockBatchId: 3, quantity: 1, locationName: 'Room 2' },
    ],
    writeoffs: [
      { stockBatchId: 1, type: 'expiry_writeoff', qty: 3 },
      { stockBatchId: 1, type: 'damage_writeoff', qty: '1' },   // MySQL SUM comes back as a string
    ],
  });
  const by = Object.fromEntries(batches.map((b) => [b.id, b]));
  assert.deepStrictEqual([by[1].status, by[1].used, by[1].writtenOff, by[1].writtenOffExpired], ['written_off', 6, 4, 3]);
  assert.deepStrictEqual([by[2].status, by[2].held, by[2].used], ['expired_on_shelf', 4, 2]);
  assert.deepStrictEqual([by[3].status, by[3].held, by[3].locations.length], ['on_shelf', 6, 2]);
  assert.deepStrictEqual([by[4].status, by[4].used], ['used_up', 5]);
});

test('used never goes negative', () => {
  const { batches } = summariseExpiry({
    today, batches: [batch(1, '2026-12-01', 2)], levels: [{ stockBatchId: 1, quantity: 5 }],
  });
  assert.strictEqual(batches[0].used, 0);
});

test('one summary line per expiry month, in order, past flagged', () => {
  const { months } = summariseExpiry({
    today,
    batches: [batch(1, '2026-11-02', 4), batch(2, '2026-09-10', 3), batch(3, '2026-11-28', 6), batch(4, '2026-10-20', 1)],
    levels: [{ stockBatchId: 2, quantity: 3 }],
  });
  assert.deepStrictEqual(months.map((m) => m.month), ['2026-09', '2026-10', '2026-11']);
  assert.deepStrictEqual(months.map((m) => m.past), [true, false, false]);
  assert.strictEqual(months[0].expiredOnShelf, 3);
  assert.deepStrictEqual([months[2].batches, months[2].received, months[2].used], [2, 10, 10]);
});

test('returned to the supplier is its own column, not "used"', () => {
  const { batches, months } = summariseExpiry({
    today, batches: [batch(1, '2026-12-01', 10)],
    writeoffs: [{ stockBatchId: 1, type: 'supplier_return', qty: 4 }],
    levels: [],
  });
  assert.deepStrictEqual([batches[0].status, batches[0].returned, batches[0].used], ['returned', 4, 6]);
  assert.strictEqual(months[0].returned, 4);
});
