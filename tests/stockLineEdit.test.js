const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const { applyMovement, LedgerError } = require('../utils/stockLedger');
const { editReceivedLine } = require('../utils/stockLineEdit');
const { clinicDatePlusDays } = require('../utils/clinicTime');

// =====================================================================
// Correcting a received delivery line, and returning stock to the supplier
// (13 Oct 2026, Emu). Real database, like tests/stockLedger.test.js: every
// fixture is tagged and removed in after().
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run stock tests against production.');
}

const TAG = '__TEST_LINE_EDIT__';
const made = { batches: [], items: [], locations: [] };
let admin; let store; let fridge; let gauze; let insulin; let swabs;

const receive = async (item, qty, location, extra = {}) => {
  const batch = await db.StockBatch.create({
    stockItemId: item.id, qtyReceived: qty, receivedAt: new Date(), status: 'active',
    expiryDate: clinicDatePlusDays(365), receivedById: admin.id, ...extra,
  });
  made.batches.push(batch.id);
  await db.sequelize.transaction((t) => applyMovement({
    type: 'intake', stockBatchId: batch.id, quantity: qty, toLocationId: location.id, performedById: admin.id,
  }, t));
  return batch;
};
const edit = (batch, changes, reason = 'typed wrong at receiving') =>
  db.sequelize.transaction((t) => editReceivedLine({ stockBatchId: batch.id, changes, reason, userId: admin.id }, t));
const held = async (batchId, locationId) =>
  (await db.StockLevel.findOne({ where: { stockBatchId: batchId, locationId } }))?.quantity || 0;

before(async () => {
  admin = await db.User.findOne({ where: { role: 'admin' } });
  assert.ok(admin, 'these tests need an admin user');
  [store, fridge] = await Promise.all([
    db.StockLocation.create({ name: `${TAG} Store`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active' }),
    db.StockLocation.create({ name: `${TAG} Fridge`, kind: 'fridge', isColdChain: true, isDispensing: true, status: 'active' }),
  ]);
  made.locations.push(store.id, fridge.id);
  [gauze, insulin, swabs] = await Promise.all([
    db.StockItem.create({ name: `${TAG} Gauze`, category: 'consumable', unit: 'piece', status: 'active' }),
    db.StockItem.create({ name: `${TAG} Insulin`, category: 'medication', unit: 'vial', requiresColdChain: true, status: 'active' }),
    db.StockItem.create({ name: `${TAG} Swabs`, category: 'consumable', unit: 'box', status: 'active' }),
  ]);
  made.items.push(gauze.id, insulin.id, swabs.id);
});

after(async () => {
  const ids = (a) => ({ [Op.in]: a.length ? a : [0] });
  await db.StockBatchEdit.destroy({ where: { stockBatchId: ids(made.batches) } });
  await db.StockMovement.destroy({ where: { stockBatchId: ids(made.batches) } });
  await db.StockLevel.destroy({ where: { stockBatchId: ids(made.batches) } });
  await db.StockBatch.destroy({ where: { id: ids(made.batches) } });
  await db.StockItem.destroy({ where: { id: ids(made.items) } });
  await db.StockLocation.destroy({ where: { id: ids(made.locations) } });
  await db.sequelize.close();
});

describe('correcting a received line', () => {
  test('quantity up and down moves the stock and keeps a record of what changed', async () => {
    const b = await receive(gauze, 4, store);
    const e1 = await edit(b, { quantity: 5 });
    assert.equal(await held(b.id, store.id), 5);
    assert.deepEqual(e1.changes, [{ field: 'quantity', from: 4, to: 5 }]);
    await edit(b, { quantity: 2 });
    await b.reload();
    assert.equal(b.qtyReceived, 2);
    assert.equal(await held(b.id, store.id), 2);
    const corrections = await db.StockMovement.count({ where: { stockBatchId: b.id, type: 'receipt_correction' } });
    assert.equal(corrections, 2, 'each quantity change is a ledger movement');
    assert.equal(await db.StockBatchEdit.count({ where: { stockBatchId: b.id } }), 2);
  });

  test('quantity 0 cancels a line received in error', async () => {
    const b = await receive(gauze, 1, store);
    await edit(b, { quantity: 0 }, 'duplicate line — merged into the first');
    await b.reload();
    assert.equal(b.qtyReceived, 0);
    assert.equal(b.status, 'depleted');
    assert.equal(await held(b.id, store.id), 0);
  });

  test('cannot take back more than is still held where it was received', async () => {
    const b = await receive(gauze, 5, store);
    await db.sequelize.transaction((t) => applyMovement({
      type: 'dispense', stockBatchId: b.id, quantity: 4, fromLocationId: store.id, performedById: admin.id,
    }, t));
    await assert.rejects(() => edit(b, { quantity: 0 }), (e) => e instanceof LedgerError && /Insufficient stock/.test(e.message));
    await b.reload();
    assert.equal(b.qtyReceived, 5, 'a refused correction changes nothing');
  });

  test('batch number and expiry are corrected, with old and new kept', async () => {
    const b = await receive(gauze, 3, store, { batchNo: 'AB12' });
    const newExpiry = clinicDatePlusDays(200);
    const e = await edit(b, { batchNo: 'AB21', expiryDate: newExpiry });
    assert.deepEqual(e.changes.map((c) => c.field), ['batchNo', 'expiryDate']);
    assert.equal(e.changes[0].from, 'AB12');
    await b.reload();
    assert.equal(b.batchNo, 'AB21');
    assert.equal(String(b.expiryDate), newExpiry);
  });

  test('an expiry corrected forward un-expires the batch', async () => {
    const b = await receive(gauze, 2, store);
    await b.update({ expiryDate: clinicDatePlusDays(-3), status: 'expired' });
    await edit(b, { expiryDate: clinicDatePlusDays(90) });
    await b.reload();
    assert.equal(b.status, 'active');
  });

  test('item can change only while nothing has left the line', async () => {
    const b = await receive(gauze, 3, store);
    await edit(b, { stockItemId: swabs.id });
    await b.reload();
    assert.equal(b.stockItemId, swabs.id);
    const mv = await db.StockMovement.findOne({ where: { stockBatchId: b.id, type: 'intake' } });
    assert.equal(mv.stockItemId, swabs.id, 'the movements follow the item');

    await db.sequelize.transaction((t) => applyMovement({
      type: 'dispense', stockBatchId: b.id, quantity: 1, fromLocationId: store.id, performedById: admin.id,
    }, t));
    await assert.rejects(() => edit(b, { stockItemId: gauze.id }), /already left this line/);
  });

  test('a cold-chain item cannot be put on a line received outside a fridge', async () => {
    const b = await receive(gauze, 1, store);
    await assert.rejects(() => edit(b, { stockItemId: insulin.id }), /requires cold chain/);
  });

  test('a reason is required, and an edit that changes nothing is refused', async () => {
    const b = await receive(gauze, 2, store);
    await assert.rejects(() => edit(b, { quantity: 3 }, ''), /reason/);
    await assert.rejects(() => edit(b, { quantity: 2 }), /Nothing was changed/);
  });
});

describe('returning stock to the supplier', () => {
  test('leaves the location; allowed for expired and recalled stock', async () => {
    const b = await receive(gauze, 6, store);
    const ret = (qty) => db.sequelize.transaction((t) => applyMovement({
      type: 'supplier_return', stockBatchId: b.id, quantity: qty, fromLocationId: store.id,
      performedById: admin.id, reason: 'short-dated on arrival',
    }, t));
    await ret(2);
    assert.equal(await held(b.id, store.id), 4);
    await b.update({ expiryDate: clinicDatePlusDays(-1), status: 'expired' });
    await ret(1);
    await b.update({ status: 'recalled' });
    await ret(1);
    assert.equal(await held(b.id, store.id), 2);
    await assert.rejects(() => db.sequelize.transaction((t) => applyMovement({
      type: 'supplier_return', stockBatchId: b.id, quantity: 1, fromLocationId: store.id, performedById: admin.id,
    }, t)), /reason is required/);
  });
});
