const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const {
  applyMovement, reverseMovement, suggestFefoBatch, rebuildLevels, LedgerError,
} = require('../utils/stockLedger');
const { clinicToday, clinicDatePlusDays, clinicStartOfDay } = require('../utils/clinicTime');
const { itemsBelowReorder, itemTotals } = require('../utils/stockTotals');

// =====================================================================
// Ledger invariants — the promises the whole stock module rests on:
// the append-only ledger and the materialized levels can never disagree,
// and stock can never silently go missing or go negative.
//
// These talk to a real database (the ledger's guarantees are transaction
// and row-lock behaviour, which a mock would not exercise). Everything is
// created under a TEST_TAG prefix and removed in after(), pass or fail.
//
//   npm test
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run stock ledger tests against production.');
}

const TAG = '__TEST_LEDGER__';
const made = { movements: [], batches: [], items: [], locations: [] };

let admin;
let store;      // ordinary dispensing location
let fridge;     // cold-chain location
let quarantine; // non-dispensing location
let itemPlain;
let itemCold;

// Create a batch and stock it into a location. Returns the batch.
//
// To set up already-expired stock we receive it dated valid and then backdate,
// because the ledger refuses an intake of expired stock — correctly, and the
// test below asserts that. It also mirrors reality: stock is received good and
// expires later on the shelf.
const stockUp = async (item, qty, location, opts = {}) => {
  const wanted = 'expiryDate' in opts ? opts.expiryDate : clinicDatePlusDays(365);
  const backdate = wanted && wanted < clinicToday();

  const batch = await db.StockBatch.create({
    stockItemId: item.id,
    qtyReceived: qty,
    receivedAt: opts.receivedAt || new Date(),
    expiryDate: backdate ? clinicDatePlusDays(1) : wanted,
    batchNo: opts.batchNo || null,
    status: 'active',
    receivedById: admin.id,
  });
  made.batches.push(batch.id);
  const mv = await db.sequelize.transaction((t) => applyMovement({
    type: 'intake', stockBatchId: batch.id, quantity: qty,
    toLocationId: location.id, performedById: admin.id,
  }, t));
  made.movements.push(mv.id);
  if (backdate) await batch.update({ expiryDate: wanted });
  return batch;
};

// Run one movement in its own transaction, recording it for cleanup.
const move = async (payload) => {
  const mv = await db.sequelize.transaction((t) => applyMovement({
    performedById: admin.id, ...payload,
  }, t));
  made.movements.push(mv.id);
  return mv;
};

const qtyAt = async (batchId, locationId) => {
  const lvl = await db.StockLevel.findOne({ where: { stockBatchId: batchId, locationId } });
  return lvl ? lvl.quantity : 0;
};

before(async () => {
  await db.sequelize.authenticate();

  admin = await db.User.findOne({ where: { role: 'admin' } });
  assert.ok(admin, 'these tests need an admin user to attribute movements to');

  [store, fridge, quarantine] = await Promise.all([
    db.StockLocation.create({ name: `${TAG} Store`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active' }),
    db.StockLocation.create({ name: `${TAG} Fridge`, kind: 'fridge', isColdChain: true, isDispensing: true, status: 'active' }),
    db.StockLocation.create({ name: `${TAG} Quarantine`, kind: 'faulty', isColdChain: false, isDispensing: false, status: 'active' }),
  ]);
  made.locations.push(store.id, fridge.id, quarantine.id);

  [itemPlain, itemCold] = await Promise.all([
    db.StockItem.create({ name: `${TAG} Gauze`, category: 'consumable', unit: 'piece', reorderLevel: 10, status: 'active' }),
    db.StockItem.create({ name: `${TAG} Insulin`, category: 'medication', unit: 'vial', requiresColdChain: true, reorderLevel: 5, status: 'active' }),
  ]);
  made.items.push(itemPlain.id, itemCold.id);
});

after(async () => {
  const ids = (a) => ({ [Op.in]: a.length ? a : [0] });
  await db.StockMovement.destroy({ where: { id: ids(made.movements) } });
  await db.StockLevel.destroy({ where: { stockBatchId: ids(made.batches) } });
  await db.StockBatch.destroy({ where: { id: ids(made.batches) } });
  await db.StockItem.destroy({ where: { id: ids(made.items) } });
  await db.StockLocation.destroy({ where: { id: ids(made.locations) } });

  const leftover = await db.StockItem.count({ where: { name: { [Op.like]: `%${TAG}%` } } })
    + await db.StockLocation.count({ where: { name: { [Op.like]: `%${TAG}%` } } });
  assert.equal(leftover, 0, 'test fixtures were not fully cleaned up');
  await db.sequelize.close();
});

// ---------------------------------------------------------------------

describe('levels can never go negative', () => {
  test('dispensing more than is held is refused', async () => {
    const batch = await stockUp(itemPlain, 3, store);
    await assert.rejects(
      () => move({ type: 'dispense', stockBatchId: batch.id, quantity: 4, fromLocationId: store.id }),
      (err) => err instanceof LedgerError && /Insufficient stock/.test(err.message)
    );
    assert.equal(await qtyAt(batch.id, store.id), 3, 'a refused dispense must not change the level');
  });

  test('two concurrent dispenses of the last unit: exactly one succeeds', async () => {
    const batch = await stockUp(itemPlain, 1, store);
    const attempt = () => db.sequelize.transaction((t) => applyMovement({
      type: 'dispense', stockBatchId: batch.id, quantity: 1,
      fromLocationId: store.id, performedById: admin.id,
    }, t));

    const results = await Promise.allSettled([attempt(), attempt()]);
    results.forEach((r) => { if (r.status === 'fulfilled') made.movements.push(r.value.id); });

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, 'the row lock must serialise these — one wins, one is refused');
    assert.equal(await qtyAt(batch.id, store.id), 0);
  });
});

describe('expired stock is frozen', () => {
  test('dispense, use and transfer are refused; expiry_writeoff is allowed', async () => {
    const batch = await stockUp(itemPlain, 10, store, { expiryDate: clinicDatePlusDays(-1) });

    for (const type of ['dispense', 'use']) {
      await assert.rejects(
        () => move({ type, stockBatchId: batch.id, quantity: 1, fromLocationId: store.id }),
        (err) => err instanceof LedgerError && /expired/.test(err.message), `${type} must be refused`
      );
    }
    await assert.rejects(
      () => move({ type: 'transfer', stockBatchId: batch.id, quantity: 1, fromLocationId: store.id, toLocationId: quarantine.id }),
      (err) => err instanceof LedgerError && /expired/.test(err.message)
    );

    await move({
      type: 'expiry_writeoff', stockBatchId: batch.id, quantity: 10,
      fromLocationId: store.id, reason: 'expired in test',
    });
    assert.equal(await qtyAt(batch.id, store.id), 0);
  });

  test('already-expired stock cannot be received in the first place', async () => {
    const batch = await db.StockBatch.create({
      stockItemId: itemPlain.id, qtyReceived: 5, receivedAt: new Date(),
      expiryDate: clinicDatePlusDays(-3), status: 'active', receivedById: admin.id,
    });
    made.batches.push(batch.id);
    await assert.rejects(
      () => move({ type: 'intake', stockBatchId: batch.id, quantity: 5, toLocationId: store.id }),
      (err) => err instanceof LedgerError && /expired/.test(err.message)
    );
  });

  test('stock is good through the whole of its expiry day', async () => {
    const batch = await stockUp(itemPlain, 2, store, { expiryDate: clinicToday() });
    await move({ type: 'dispense', stockBatchId: batch.id, quantity: 1, fromLocationId: store.id });
    assert.equal(await qtyAt(batch.id, store.id), 1, 'expiring today must still be dispensable today');
  });
});

describe('cold chain is a hard block', () => {
  test('a cold-chain item cannot be placed in a non-fridge location', async () => {
    const batch = await stockUp(itemCold, 5, fridge);
    await assert.rejects(
      () => move({ type: 'transfer', stockBatchId: batch.id, quantity: 1, fromLocationId: fridge.id, toLocationId: store.id }),
      (err) => err instanceof LedgerError && /cold chain/i.test(err.message)
    );
    assert.equal(await qtyAt(batch.id, fridge.id), 5);
  });

  test('fridge to fridge is fine', async () => {
    const batch = await stockUp(itemCold, 5, fridge);
    const other = await db.StockLocation.create({
      name: `${TAG} Fridge 2`, kind: 'fridge', isColdChain: true, isDispensing: true, status: 'active',
    });
    made.locations.push(other.id);
    await move({ type: 'transfer', stockBatchId: batch.id, quantity: 2, fromLocationId: fridge.id, toLocationId: other.id });
    assert.equal(await qtyAt(batch.id, fridge.id), 3);
    assert.equal(await qtyAt(batch.id, other.id), 2);
  });
});

describe('recalled batches are fully frozen', () => {
  test('no movement type is accepted, not even a write-off', async () => {
    const batch = await stockUp(itemPlain, 5, store);
    await batch.update({ status: 'recalled' });

    for (const payload of [
      { type: 'dispense', fromLocationId: store.id },
      { type: 'use', fromLocationId: store.id },
      { type: 'expiry_writeoff', fromLocationId: store.id, reason: 'x' },
      { type: 'adjustment', fromLocationId: store.id, reason: 'x' },
    ]) {
      await assert.rejects(
        () => move({ stockBatchId: batch.id, quantity: 1, ...payload }),
        (err) => err instanceof LedgerError && /recalled/.test(err.message),
        `${payload.type} must be refused on a recalled batch`
      );
    }
    assert.equal(await qtyAt(batch.id, store.id), 5);
  });
});

describe('reversal is the only correction', () => {
  test('a reversal restores the level exactly', async () => {
    const batch = await stockUp(itemPlain, 10, store);
    const dispense = await move({ type: 'dispense', stockBatchId: batch.id, quantity: 4, fromLocationId: store.id });
    assert.equal(await qtyAt(batch.id, store.id), 6);

    const rev = await db.sequelize.transaction((t) => reverseMovement(dispense.id, admin.id, 'wrong patient', t));
    made.movements.push(rev.id);
    assert.equal(await qtyAt(batch.id, store.id), 10, 'the level must return to exactly where it was');
    assert.equal(rev.reversesMovementId, dispense.id);
  });

  test('the same movement cannot be reversed twice', async () => {
    const batch = await stockUp(itemPlain, 10, store);
    const dispense = await move({ type: 'dispense', stockBatchId: batch.id, quantity: 2, fromLocationId: store.id });
    const rev = await db.sequelize.transaction((t) => reverseMovement(dispense.id, admin.id, 'once', t));
    made.movements.push(rev.id);

    await assert.rejects(
      () => db.sequelize.transaction((t) => reverseMovement(dispense.id, admin.id, 'twice', t)),
      (err) => err instanceof LedgerError && /already been reversed/.test(err.message)
    );
    assert.equal(await qtyAt(batch.id, store.id), 10, 'a refused double-reversal must not inflate stock');
  });

  test('a reversal cannot itself be reversed', async () => {
    const batch = await stockUp(itemPlain, 10, store);
    const dispense = await move({ type: 'dispense', stockBatchId: batch.id, quantity: 2, fromLocationId: store.id });
    const rev = await db.sequelize.transaction((t) => reverseMovement(dispense.id, admin.id, 'once', t));
    made.movements.push(rev.id);

    await assert.rejects(
      () => db.sequelize.transaction((t) => reverseMovement(rev.id, admin.id, 'nope', t)),
      (err) => err instanceof LedgerError && /cannot itself be reversed/.test(err.message)
    );
  });
});

describe('batch status tracks what is actually held', () => {
  test('active to depleted and back again', async () => {
    const batch = await stockUp(itemPlain, 3, store);
    assert.equal(batch.status, 'active');

    const out = await move({ type: 'dispense', stockBatchId: batch.id, quantity: 3, fromLocationId: store.id });
    await batch.reload();
    assert.equal(batch.status, 'depleted', 'nothing left anywhere means depleted');

    const rev = await db.sequelize.transaction((t) => reverseMovement(out.id, admin.id, 'came back', t));
    made.movements.push(rev.id);
    await batch.reload();
    assert.equal(batch.status, 'active', 'stock returning must reactivate the batch');
  });
});

describe('FEFO picks the right batch', () => {
  test('earliest expiry wins, receivedAt breaks ties, undated goes last', async () => {
    const item = await db.StockItem.create({
      name: `${TAG} FEFO Item`, category: 'consumable', unit: 'piece', status: 'active',
    });
    made.items.push(item.id);
    const loc = await db.StockLocation.create({
      name: `${TAG} FEFO Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(loc.id);

    await stockUp(item, 5, loc, { expiryDate: null });                          // undated — last
    const late = await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(90) });
    const early = await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(10) });

    let s = await suggestFefoBatch(item.id, loc.id);
    assert.equal(s.batch.id, early.id, 'earliest expiry must be suggested');

    // Same expiry as `early`, but received earlier — the tiebreaker.
    const earlierReceipt = await stockUp(item, 5, loc, {
      expiryDate: clinicDatePlusDays(10),
      receivedAt: new Date(Date.now() - 86400_000),
    });
    s = await suggestFefoBatch(item.id, loc.id);
    assert.equal(s.batch.id, earlierReceipt.id, 'on equal expiry the older receipt wins');

    // Drain both dated-soonest batches; the 90-day one should surface next.
    await move({ type: 'dispense', stockBatchId: earlierReceipt.id, quantity: 5, fromLocationId: loc.id });
    await move({ type: 'dispense', stockBatchId: early.id, quantity: 5, fromLocationId: loc.id });
    s = await suggestFefoBatch(item.id, loc.id);
    assert.equal(s.batch.id, late.id, 'dated batches come before undated ones');
  });

  test('expired batches are never suggested', async () => {
    const item = await db.StockItem.create({
      name: `${TAG} FEFO Expired`, category: 'consumable', unit: 'piece', status: 'active',
    });
    made.items.push(item.id);
    const loc = await db.StockLocation.create({
      name: `${TAG} FEFO Room 2`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(loc.id);

    await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(-5) });
    const good = await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(30) });

    const s = await suggestFefoBatch(item.id, loc.id);
    assert.equal(s.batch.id, good.id, 'an expired batch must never be suggested for dispensing');
  });
});

describe('derived totals', () => {
  test('an item at zero everywhere still counts as below reorder', async () => {
    const item = await db.StockItem.create({
      name: `${TAG} Stocked Out`, category: 'consumable', unit: 'piece', reorderLevel: 10, status: 'active',
    });
    made.items.push(item.id);

    // No batches at all — the item has never been stocked, so it has no
    // StockLevel rows. A levels-first roll-up drops it silently.
    const rows = await itemsBelowReorder();
    const row = rows.find((i) => i.id === item.id);
    assert.ok(row, 'an item with no stock at all must appear below reorder');
    assert.equal(row.totalQuantity, 0);
  });

  test('totals sum across locations', async () => {
    const item = await db.StockItem.create({
      name: `${TAG} Split Item`, category: 'consumable', unit: 'piece', reorderLevel: 100, status: 'active',
    });
    made.items.push(item.id);
    await stockUp(item, 7, store);
    await stockUp(item, 5, quarantine);

    const totals = await itemTotals();
    assert.equal(totals[item.id], 12, 'quantities in every location must be counted');
  });
});

describe('the ledger is authoritative', () => {
  test('rebuildLevels reproduces the levels table from the movements', async () => {
    const batch = await stockUp(itemPlain, 20, store);
    await move({ type: 'transfer', stockBatchId: batch.id, quantity: 8, fromLocationId: store.id, toLocationId: quarantine.id });
    await move({ type: 'dispense', stockBatchId: batch.id, quantity: 3, fromLocationId: store.id });

    const before = { store: await qtyAt(batch.id, store.id), quar: await qtyAt(batch.id, quarantine.id) };
    assert.deepEqual(before, { store: 9, quar: 8 });

    // Deliberately corrupt the cache, then prove the ledger can restore it.
    await db.StockLevel.update({ quantity: 999 }, { where: { stockBatchId: batch.id, locationId: store.id } });
    await rebuildLevels();

    assert.equal(await qtyAt(batch.id, store.id), before.store, 'rebuild must recompute from the ledger');
    assert.equal(await qtyAt(batch.id, quarantine.id), before.quar);
  });
});

describe('behaviour under production load', () => {
  test('rebuildLevels sums in SQL and still matches a hand-computed ledger', async () => {
    const room = await db.StockLocation.create({
      name: `${TAG} Rebuild Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(room.id);

    // A batch with movement in both directions across two locations, so the
    // two grouped queries (out of a location, into a location) both contribute.
    const batch = await stockUp(itemPlain, 100, room);
    await move({ type: 'transfer', stockBatchId: batch.id, quantity: 40, fromLocationId: room.id, toLocationId: store.id });
    await move({ type: 'dispense', stockBatchId: batch.id, quantity: 15, fromLocationId: room.id });
    await move({ type: 'dispense', stockBatchId: batch.id, quantity: 5, fromLocationId: store.id });
    const back = await move({ type: 'return', stockBatchId: batch.id, quantity: 3, toLocationId: room.id });
    assert.ok(back.id);

    const expected = { room: 100 - 40 - 15 + 3, store: 40 - 5 };
    assert.deepEqual(
      { room: await qtyAt(batch.id, room.id), store: await qtyAt(batch.id, store.id) },
      expected
    );

    // Corrupt both rows, then prove the SQL rebuild restores them.
    await db.StockLevel.update({ quantity: 4242 }, { where: { stockBatchId: batch.id } });
    await rebuildLevels();

    assert.equal(await qtyAt(batch.id, room.id), expected.room);
    assert.equal(await qtyAt(batch.id, store.id), expected.store);
  });

  test('a multi-line checkout applies every line in one transaction', async () => {
    const patient = await db.Patient.findOne({ where: { status: 'Active' } })
      || await db.Patient.findOne();
    if (!patient) return; // no patients in this database — nothing to assert against

    const ctrl = require('../controllers/stockMovementController');
    const a = await stockUp(itemPlain, 20, store);
    const b = await stockUp(itemPlain, 20, store);

    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (x) => { res.body = x; return res; };

    // Lines deliberately out of id order — the controller sorts them so
    // concurrent checkouts always take row locks in the same sequence.
    await ctrl.checkoutDispense({
      body: {
        uhid: patient.uhid,
        lines: [
          { stockBatchId: b.id, locationId: store.id, quantity: 2 },
          { stockBatchId: a.id, locationId: store.id, quantity: 3 },
        ],
      },
      user: admin,
    }, res);

    (res.body?.data?.movements || []).forEach((m) => made.movements.push(m.id));
    assert.equal(res.code, 201, res.body?.message || '');
    assert.equal(await qtyAt(a.id, store.id), 17);
    assert.equal(await qtyAt(b.id, store.id), 18);
  });

  test('the inventory report reports the LATEST intake per item, not an arbitrary one', async () => {
    const reports = require('../controllers/stockReportController');
    const item = await db.StockItem.create({
      name: `${TAG} Reordered Item`, category: 'consumable', unit: 'piece', reorderLevel: 5, status: 'active',
    });
    made.items.push(item.id);

    // Three deliveries. Only the newest should appear as lastOrder — the
    // narrowing now happens in SQL rather than by scanning every intake ever.
    await stockUp(item, 10, store);
    await new Promise((r) => setTimeout(r, 1100)); // MySQL DATETIME is second-resolution
    await stockUp(item, 25, store);
    await new Promise((r) => setTimeout(r, 1100));
    await stockUp(item, 7, store);

    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await reports.inventory({ query: {}, params: {}, body: {}, user: admin }, res);

    assert.equal(res.code, 200, res.body?.message || '');
    const row = (res.body.data || []).find((r) => r.id === item.id);
    assert.ok(row, 'the item must appear on the inventory sheet');
    assert.equal(row.totalQuantity, 42, '10 + 25 + 7');
    assert.equal(row.lastOrder?.quantity, 7, 'the most recent delivery, not the largest or the first');
  });

  test('FEFO inside a transaction sees that transaction, not a stale snapshot', async () => {
    const item = await db.StockItem.create({
      name: `${TAG} Txn FEFO`, category: 'consumable', unit: 'piece', status: 'active',
    });
    made.items.push(item.id);
    const loc = await db.StockLocation.create({
      name: `${TAG} Txn Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(loc.id);

    const soon = await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(5) });
    const later = await stockUp(item, 5, loc, { expiryDate: clinicDatePlusDays(60) });

    await db.sequelize.transaction(async (t) => {
      const before = await suggestFefoBatch(item.id, loc.id, t);
      assert.equal(before.batch.id, soon.id, 'earliest expiry first');

      // Empty the earliest batch inside this transaction...
      const mv = await applyMovement({
        type: 'dispense', stockBatchId: soon.id, quantity: 5,
        fromLocationId: loc.id, performedById: admin.id,
      }, t);
      made.movements.push(mv.id);

      // ...and FEFO must now see that, which it only can on the same connection.
      const after = await suggestFefoBatch(item.id, loc.id, t);
      assert.equal(after.batch.id, later.id,
        'without the transaction this read would still show the depleted batch');
    });
  });
});

describe('stocktake reconciles the whole location', () => {
  const rooms = require('../controllers/stockRoomController');

  // Minimal res double — the controller only uses status().json().
  const capture = () => {
    const r = { code: 200, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  const runCount = async (body) => {
    const res = capture();
    await rooms.stocktake({ body, user: admin }, res);
    return res;
  };

  // Adjustments the controller writes aren't returned, so collect them for cleanup.
  const collectAdjustments = async (batchIds) => {
    const rows = await db.StockMovement.findAll({
      where: { type: 'adjustment', stockBatchId: { [Op.in]: batchIds } },
    });
    rows.forEach((m) => made.movements.push(m.id));
  };

  test('a batch nobody scanned is written down to zero', async () => {
    const room = await db.StockLocation.create({
      name: `${TAG} Count Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(room.id);
    const scanned = await stockUp(itemPlain, 10, room);
    const vanished = await stockUp(itemPlain, 6, room);

    const res = await runCount({
      locationId: room.id,
      counts: [{ stockBatchId: scanned.id, countedQty: 10 }],
      note: 'monthly',
    });
    await collectAdjustments([scanned.id, vanished.id]);

    assert.equal(res.body.data.missing, 1, 'the unscanned batch must be reported missing');
    assert.equal(await qtyAt(vanished.id, room.id), 0, 'missing stock must be written down to zero');
    assert.equal(await qtyAt(scanned.id, room.id), 10, 'the counted batch is untouched');

    const adj = await db.StockMovement.findOne({
      where: { type: 'adjustment', stockBatchId: vanished.id },
    });
    assert.match(adj.reason, /expected 6, counted 0/, 'must use the shape the inventory report parses');
    assert.match(adj.reason, /not scanned/);
  });

  test("partial mode leaves unscanned batches alone", async () => {
    const room = await db.StockLocation.create({
      name: `${TAG} Shelf Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(room.id);
    const scanned = await stockUp(itemPlain, 4, room);
    const other = await stockUp(itemPlain, 9, room);

    const res = await runCount({
      locationId: room.id,
      counts: [{ stockBatchId: scanned.id, countedQty: 4 }],
      mode: 'partial',
    });
    await collectAdjustments([scanned.id, other.id]);

    assert.equal(res.body.data.missing, 0);
    assert.equal(await qtyAt(other.id, room.id), 9, 'a shelf count must not zero the rest of the room');
  });

  test('stock delivered mid-count is not written off', async () => {
    const room = await db.StockLocation.create({
      name: `${TAG} Busy Room`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active',
    });
    made.locations.push(room.id);
    const onShelf = await stockUp(itemPlain, 5, room);

    // The counter draws their list...
    const startedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 1100)); // MySQL DATETIME is second-resolution

    // ...and a delivery lands in the room while they are still counting.
    const lateArrival = await stockUp(itemPlain, 12, room);

    const res = await runCount({
      locationId: room.id,
      counts: [{ stockBatchId: onShelf.id, countedQty: 5 }],
      startedAt,
    });
    await collectAdjustments([onShelf.id, lateArrival.id]);

    assert.equal(res.body.data.arrivedDuringCount, 1);
    assert.equal(res.body.data.missing, 0);
    assert.equal(await qtyAt(lateArrival.id, room.id), 12,
      'a delivery that arrived after the count began must survive it');
  });
});

describe('one definition of today', () => {
  test('clinic dates are consistent and timezone-independent', () => {
    const today = clinicToday();
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(clinicDatePlusDays(0), today);
    assert.ok(clinicDatePlusDays(1) > today, 'ISO date strings must sort chronologically');
    assert.ok(clinicDatePlusDays(-1) < today);

    // Midnight belongs to today; one second earlier belongs to yesterday.
    const start = clinicStartOfDay();
    assert.equal(clinicToday(start), today);
    assert.equal(clinicToday(new Date(start.getTime() - 1000)), clinicDatePlusDays(-1));
  });

  test('date arithmetic crosses month and year boundaries', () => {
    const dec31 = new Date('2026-12-31T12:00:00Z');
    assert.equal(clinicDatePlusDays(1, dec31), '2027-01-01');
    assert.equal(clinicDatePlusDays(-1, new Date('2026-03-01T12:00:00Z')), '2026-02-28');
  });
});
