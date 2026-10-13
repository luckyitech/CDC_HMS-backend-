const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const rooms = require('../controllers/stockRoomController');
const movements = require('../controllers/stockMovementController');
const catalog = require('../controllers/stockCatalogController');
const reports = require('../controllers/stockReportController');
const { applyMovement } = require('../utils/stockLedger');
const { collectStockRows } = require('../utils/stockAudit');
const { buildSessions, buildPeople } = require('../utils/stockAuditReport');
const { clinicDatePlusDays, clinicToday } = require('../utils/clinicTime');

// =====================================================================
// Stock audit (13 Oct 2026, Emu): every Stocks function is timestamped and
// surfaces in the activity views and Analytics → Audit. Real database, like
// tests/stockLineEdit.test.js: every fixture is tagged and removed in after().
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run stock tests against production.');
}

const TAG = '__TEST_STOCK_AUDIT__';
let admin; let user; let store; let room; let gauze; let receipt; const batches = [];
const since = new Date(Date.now() - 60000);
const window = () => ({ [Op.gte]: since });
const mine = async () => (await collectStockRows(window())).filter((r) => r.userId === admin.id
  && (String(r.detail || '').includes(TAG) || String(r.location || '').includes(TAG) || String(r.item || '').includes(TAG)));

const call = (fn, req) => new Promise((resolve, reject) => {
  const res = {
    status(c) { this.code = c; return this; },
    json(b) { resolve({ code: this.code || 200, ...b }); },
  };
  Promise.resolve(fn({ query: {}, params: {}, body: {}, user, ...req }, res)).catch(reject);
});

before(async () => {
  admin = await db.User.findOne({ where: { role: 'admin' } });
  assert.ok(admin, 'these tests need an admin user');
  user = { id: admin.id, role: 'admin', name: 'Test admin' };
  store = await db.StockLocation.create({ name: `${TAG} Store`, kind: 'store', isColdChain: false, isDispensing: true, status: 'active' });
  room = await db.StockLocation.create({ name: `${TAG} Room`, kind: 'doctor_room', isColdChain: false, isDispensing: true, status: 'active' });
  gauze = await db.StockItem.create({ name: `${TAG} Gauze`, category: 'consumable', unit: 'box', status: 'active' });
  receipt = await db.StockReceipt.create({ number: `${TAG}-INV-1`, numberKey: `${TAG}-INV-1`, kind: 'invoice', createdById: admin.id });
  for (let i = 0; i < 2; i++) {
    const b = await db.StockBatch.create({
      stockItemId: gauze.id, qtyReceived: 5, receivedAt: new Date(), status: 'active', stockReceiptId: receipt.id,
      expiryDate: clinicDatePlusDays(300 + i), receivedById: admin.id, batchNo: `${TAG}-B${i}`,
    });
    batches.push(b.id);
    await db.sequelize.transaction((t) => applyMovement({ type: 'intake', stockBatchId: b.id, quantity: 5, toLocationId: store.id, performedById: admin.id }, t));
  }
});

after(async () => {
  const ids = { [Op.in]: batches };
  await db.StockMovement.destroy({ where: { stockBatchId: ids } });
  await db.StockLevel.destroy({ where: { stockBatchId: ids } });
  await db.StockBatch.destroy({ where: { id: ids } });
  await db.StockActivity.destroy({ where: { [Op.or]: [{ locationId: { [Op.in]: [store.id, room.id] } }, { stockItemId: gauze.id }] } });
  await db.StockParLevel.destroy({ where: { locationId: room.id } });
  await db.StockReceipt.destroy({ where: { id: receipt.id } });
  await db.StockItem.destroy({ where: { id: gauze.id } });
  await db.StockLocation.destroy({ where: { id: { [Op.in]: [store.id, room.id] } } });
  await db.sequelize.close();
});

test('a stocktake where every count matched is still recorded, with who, where and how long', async () => {
  const startedAt = new Date(Date.now() - 12 * 60000).toISOString();
  const levels = await db.StockLevel.findAll({ where: { locationId: store.id } });
  const r = await call(rooms.stocktake, { body: {
    locationId: store.id, mode: 'full', startedAt, note: 'monthly',
    counts: levels.map((l) => ({ stockBatchId: l.stockBatchId, countedQty: l.quantity })),
  } });
  assert.equal(r.success, true);
  const row = await db.StockActivity.findOne({ where: { action: 'stocktake', locationId: store.id } });
  assert.ok(row, 'stocktake recorded');
  assert.match(row.detail, /Full count · 2 batches counted · 2 matched · 0 adjusted · note: monthly/);
  assert.ok(Math.abs(new Date(row.startedAt) - new Date(startedAt)) < 1000, 'startedAt kept (to the second)');
  const s = buildSessions(await mine()).find((x) => x.fn === 'stocktake');
  assert.equal(s.location, `${TAG} Store`);
  assert.ok(new Date(s.endAt) - new Date(s.at) >= 11 * 60000, 'session spans the count');
});

test('par changes and the room doctor are recorded with what changed', async () => {
  const doctor = await db.User.findOne({ where: { role: 'doctor', isActive: true } });
  const r = await call(rooms.setParLevels, { body: {
    locationId: room.id, entries: [{ stockItemId: gauze.id, minQty: 2, maxQty: 6 }],
    ...(doctor ? { assignedDoctorId: doctor.id } : {}),
  } });
  assert.equal(r.success, true);
  const pars = await db.StockActivity.findOne({ where: { action: 'pars_changed', locationId: room.id } });
  assert.match(pars.detail, new RegExp(`1 item: ${TAG} Gauze none → 2–6`));
  if (doctor) {
    const doc = await db.StockActivity.findOne({ where: { action: 'room_doctor', locationId: room.id } });
    assert.match(doc.detail, new RegExp(`Dr\\. ${doctor.firstName}`));
  }
  // Saving the same pars again changes nothing — nothing new recorded.
  await call(rooms.setParLevels, { body: { locationId: room.id, entries: [{ stockItemId: gauze.id, minQty: 2, maxQty: 6 }] } });
  assert.equal(await db.StockActivity.count({ where: { action: 'pars_changed', locationId: room.id } }), 1);
});

test('a restock picklist line shows as room balancing, a plain transfer as a transfer', async () => {
  const r1 = await call(movements.transfer, { body: { stockBatchId: batches[0], fromLocationId: store.id, toLocationId: room.id, quantity: 2, restock: true } });
  assert.equal(r1.success, true, r1.message);
  const r2 = await call(movements.transfer, { body: { stockBatchId: batches[0], fromLocationId: store.id, toLocationId: room.id, quantity: 1 } });
  assert.equal(r2.success, true, r2.message);
  const rows = await mine();
  assert.equal(rows.filter((x) => x.type === 'stock_restocked').length, 1);
  assert.equal(rows.filter((x) => x.type === 'stock_transferred').length, 1);
});

test('catalogue edits record the fields that changed', async () => {
  const r = await call(catalog.updateItem, { params: { id: gauze.id }, body: { reorderLevel: 4 } });
  assert.equal(r.success, true);
  const row = await db.StockActivity.findOne({ where: { action: 'catalog_edited', stockItemId: gauze.id } });
  assert.match(row.detail, /reorderLevel: 0 → 4/);
});

test('deliveries group into one receiving session per document; people are counted', async () => {
  const rows = await mine();
  const sessions = buildSessions(rows);
  const recv = sessions.filter((s) => s.fn === 'receiving');
  assert.equal(recv.length, 1);
  assert.match(recv[0].summary, new RegExp(`${TAG}-INV-1 · 2 lines · 10 units`));
  const me = buildPeople(rows, sessions).find((p) => p.userId === admin.id);
  assert.equal(me.receiving, 1);
  assert.equal(me.stocktakes, 1);
  assert.equal(me.restocks, 1);
  assert.equal(me.transfers, 1);
});

test('the audit report and the HMS activity log both carry them', async () => {
  const today = clinicToday();
  const r = await call(reports.audit, { query: { from: today, to: today, userId: String(admin.id) } });
  assert.equal(r.success, true);
  assert.ok(r.data.events.some((e) => e.type === 'stock_stocktake'));
  assert.ok(r.data.lastDone.stocktake.find((l) => l.locationId === store.id).at, 'last stocktake known');
  assert.ok(r.data.lastDone.restock.find((l) => l.locationId === room.id).at, 'last restock known');
  const { collectAllEvents, resolveDateFilter } = require('../controllers/activityController');
  const all = await collectAllEvents(resolveDateFilter());
  assert.ok(all.some((e) => e.type === 'stock_restocked' && /Gauze/.test(e.detail)));
});
