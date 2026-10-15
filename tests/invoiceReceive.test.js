const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');

const db = require('../models');
const invoices = require('../controllers/stockInvoiceController');
const { aliasKeyOf } = require('../utils/stockItemMatch');
const { ensureStockReceiptDir } = require('../utils/stockReceiptStorage');
const { clinicDatePlusDays } = require('../utils/clinicTime');

// =====================================================================
// Receiving from an invoice (13 Oct 2026, Emu) — the save: every line in one
// transaction, the scan attached, the supplier's wording remembered, and the
// one-item intake unchanged. Real database, like tests/stockLineEdit.test.js;
// every fixture is tagged and removed in after(). The reader itself (the
// Claude API call) is not exercised here — its normaliser is unit-tested.
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run stock tests against production.');
}

const TAG = '__TEST_INVOICE_RECEIVE__';
const made = { batches: [], items: [], locations: [], suppliers: [], receipts: [], files: [] };
let admin; let store; let fridge; let strips; let insulin; let supplier;

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const call = async (fn, body) => { const r = res(); await fn({ body, user: { id: admin.id }, params: {} }, r); return r; };
const pendingFile = () => {
  const name = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(ensureStockReceiptDir(), name), 'not really a jpeg');
  made.files.push(name);
  return name;
};
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
  [strips, insulin] = await Promise.all([
    db.StockItem.create({ name: `${TAG} Glucose strip`, category: 'diagnostic', unit: 'strip', packSize: 50, status: 'active' }),
    db.StockItem.create({ name: `${TAG} Insulin pen`, category: 'medication', unit: 'pen', requiresColdChain: true, status: 'active' }),
  ]);
  made.items.push(strips.id, insulin.id);
  supplier = await db.Supplier.create({ name: `${TAG} Supplier`, status: 'active' });
  made.suppliers.push(supplier.id);
});

after(async () => {
  const ids = (a) => ({ [Op.in]: a.length ? a : [0] });
  const batches = await db.StockBatch.findAll({ where: { [Op.or]: [{ id: ids(made.batches) }, { supplierId: ids(made.suppliers) }] }, attributes: ['id'] });
  const batchIds = batches.map((b) => b.id);
  await db.StockMovement.destroy({ where: { stockBatchId: ids(batchIds) } });
  await db.StockLevel.destroy({ where: { stockBatchId: ids(batchIds) } });
  await db.StockBatch.destroy({ where: { id: ids(batchIds) } });
  await db.StockSupplierAlias.destroy({ where: { stockItemId: ids(made.items) } });
  const receipts = await db.StockReceipt.findAll({ where: { supplierId: ids(made.suppliers) }, attributes: ['id'] });
  await db.StockReceiptDocument.destroy({ where: { stockReceiptId: ids(receipts.map((r) => r.id)) } });
  await db.StockReceipt.destroy({ where: { id: ids(receipts.map((r) => r.id)) } });
  await db.StockActivity.destroy({ where: { userId: admin.id, action: 'invoice_read', detail: { [Op.like]: `%${TAG}%` } } });
  await db.StockItem.destroy({ where: { id: ids(made.items) } });
  await db.StockLocation.destroy({ where: { id: ids(made.locations) } });
  await db.Supplier.destroy({ where: { id: ids(made.suppliers) } });
  made.files.forEach((n) => { try { fs.unlinkSync(path.join(ensureStockReceiptDir(), n)); } catch { /* gone */ } });
  await db.sequelize.close();
});

describe('receiving from an invoice', () => {
  test('all lines save together: batches, labels, levels, the scan, and the wording remembered', async () => {
    const token = pendingFile();
    const r = await call(invoices.receiveBatch, {
      uploadToken: token, fileName: 'inv.jpg', supplierId: supplier.id, receiptNo: ' inv 7001 ', receiptKind: 'invoice', locationId: store.id,
      lines: [
        { stockItemId: strips.id, quantity: 500, batchNo: 'GF1', expiryDate: clinicDatePlusDays(300), sourceText: 'GLUCOFIX STRP 50S', corrections: ['batchNo'] },
        { stockItemId: insulin.id, quantity: 20, batchNo: 'LG3', expiryDate: clinicDatePlusDays(200), locationId: fridge.id, sourceText: 'INS GLARGINE PEN 5S', corrections: [] },
      ],
    });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    const { items, receipt, scanAttached } = r.body.data;
    assert.equal(items.length, 2);
    assert.ok(scanAttached);
    assert.equal(receipt.number, 'inv 7001');
    made.batches.push(...items.map((i) => i.batchId));
    assert.match(items[0].labelCode, /^STK-\d{6}$/);
    assert.equal(await held(items[0].batchId, store.id), 500);
    assert.equal(await held(items[1].batchId, fridge.id), 20);

    const b = await db.StockBatch.findByPk(items[0].batchId);
    assert.equal(b.receiveMethod, 'invoice');
    assert.equal(b.sourceText, 'GLUCOFIX STRP 50S');
    assert.equal(b.sourceCorrections, 'batchNo');

    const alias = await db.StockSupplierAlias.findOne({ where: { supplierId: supplier.id, aliasKey: aliasKeyOf('GLUCOFIX STRP 50S') } });
    assert.ok(alias, 'wording remembered');
    assert.equal(alias.stockItemId, strips.id);

    const doc = await db.StockReceiptDocument.findOne({ where: { filePath: token } });
    assert.ok(doc, 'scan attached to the delivery');
    assert.equal(doc.stockReceiptId, receipt.id);
    assert.equal(doc.mimeType, 'image/jpeg');
  });

  test('a corrected match replaces the remembered item; saving the same scan twice is refused', async () => {
    const r = await call(invoices.receiveBatch, {
      supplierId: supplier.id, receiptNo: 'INV 7002', locationId: store.id,
      lines: [{ stockItemId: insulin.id, quantity: 5, expiryDate: clinicDatePlusDays(100), locationId: fridge.id, sourceText: 'glucofix strp 50s', corrections: ['item'] }],
    });
    assert.equal(r.statusCode, 201, JSON.stringify(r.body));
    made.batches.push(...r.body.data.items.map((i) => i.batchId));
    const alias = await db.StockSupplierAlias.findOne({ where: { supplierId: supplier.id, aliasKey: aliasKeyOf('GLUCOFIX STRP 50S') } });
    assert.equal(alias.stockItemId, insulin.id, 'newest confirmation wins');
    assert.equal(alias.useCount, 2);

    const attached = await db.StockReceiptDocument.findOne({ where: { stockReceiptId: { [Op.ne]: null } }, order: [['id', 'DESC']] });
    const again = await call(invoices.receiveBatch, {
      uploadToken: attached.filePath, supplierId: supplier.id, receiptNo: 'INV 7001', locationId: store.id,
      lines: [{ stockItemId: strips.id, quantity: 1 }],
    });
    assert.equal(again.statusCode, 409);
  });

  test('one bad line → nothing is saved (a medication without expiry, a cold-chain item into the store)', async () => {
    const before = await db.StockBatch.count({ where: { supplierId: supplier.id } });
    const noExpiry = await call(invoices.receiveBatch, {
      supplierId: supplier.id, receiptNo: 'INV 7003', locationId: store.id,
      lines: [{ stockItemId: strips.id, quantity: 50 }, { stockItemId: insulin.id, quantity: 5, locationId: fridge.id }],
    });
    assert.equal(noExpiry.statusCode, 400);
    assert.match(noExpiry.body.message, /Line 2: Expiry date is required/);

    const warmInsulin = await call(invoices.receiveBatch, {
      supplierId: supplier.id, receiptNo: 'INV 7003', locationId: store.id,
      lines: [{ stockItemId: strips.id, quantity: 50 }, { stockItemId: insulin.id, quantity: 5, expiryDate: clinicDatePlusDays(100) }],
    });
    assert.equal(warmInsulin.statusCode, 400, JSON.stringify(warmInsulin.body));
    assert.match(warmInsulin.body.message, /cold chain/);

    assert.equal(await db.StockBatch.count({ where: { supplierId: supplier.id } }), before, 'the good line was rolled back too');
    assert.equal(await db.StockReceipt.count({ where: { supplierId: supplier.id, numberKey: 'INV 7003' } }), 0, 'no receipt left behind');
  });

  test('a line with no location is refused before anything is saved', async () => {
    const r = await call(invoices.receiveBatch, {
      supplierId: supplier.id, receiptNo: 'INV 7004',
      lines: [{ stockItemId: strips.id, quantity: 5, locationId: store.id }, { stockItemId: strips.id, quantity: 5 }],
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /Line 2: choose where/);
    assert.equal(await db.StockReceipt.count({ where: { supplierId: supplier.id, numberKey: 'INV 7004' } }), 0);
  });

  test('a cancelled read discards its file; an attached scan cannot be discarded', async () => {
    const token = pendingFile();
    const r = res();
    await invoices.discard({ params: { token }, user: { id: admin.id } }, r);
    assert.equal(r.statusCode, 200);
    assert.ok(!fs.existsSync(path.join(ensureStockReceiptDir(), token)));

    const attached = await db.StockReceiptDocument.findOne({ where: { stockReceiptId: { [Op.ne]: null } }, order: [['id', 'DESC']] });
    const r2 = res();
    await invoices.discard({ params: { token: attached.filePath }, user: { id: admin.id } }, r2);
    assert.equal(r2.statusCode, 409);
    assert.ok(fs.existsSync(path.join(ensureStockReceiptDir(), attached.filePath)));
  });

  test('read: lines matched (remembered / suggested / unmatched / skipped), supplier matched, duplicate flagged', async () => {
    const reader = require('../utils/invoiceReader');
    const real = reader.readInvoice;
    reader.readInvoice = async () => ({
      supplierName: `${TAG} SUPPLIER LTD`, supplierPhone: '0700', supplierEmail: 's@x.com', supplierAddress: 'PO Box 1', supplierTaxPin: 'P1', supplierNotes: null, documentKind: 'invoice', documentNumber: 'INV 7001', documentDate: '2026-10-13', notes: null, model: 'stub',
      lines: [
        { description: 'GLUCOFIX STRP 50S', isStockItem: true, batchNo: 'GF2', expiryDate: '2027-08-31', packs: 10, packSize: 50, quantity: 500, unit: 'strip', uncertain: [] },
        { description: `${TAG} Glucose strips`, isStockItem: true, batchNo: null, expiryDate: null, packs: null, packSize: null, quantity: 100, unit: null, uncertain: ['batchNo'] },
        { description: 'SOMETHING NOBODY STOCKS 9000', isStockItem: true, batchNo: null, expiryDate: null, packs: null, packSize: null, quantity: 1, unit: null, uncertain: [] },
        { description: 'DELIVERY CHARGE', isStockItem: false, batchNo: null, expiryDate: null, packs: null, packSize: null, quantity: null, unit: null, uncertain: [] },
      ],
    });
    const token = pendingFile();
    try {
      const r = res();
      await invoices.read({
        file: { path: path.join(ensureStockReceiptDir(), token), filename: token, originalname: 'inv.jpg', mimetype: 'image/jpeg' },
        body: {}, user: { id: admin.id },
      }, r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      const d = r.body.data;
      assert.equal(d.uploadToken, token);
      assert.equal(d.supplier.id, supplier.id, 'supplier matched by name');
      assert.deepEqual(d.supplier.details, { contactPhone: '0700', contactEmail: 's@x.com', address: 'PO Box 1', taxPin: 'P1', notes: null });
      assert.equal(d.lines[0].status, 'remembered');
      assert.equal(d.lines[0].stockItemId, insulin.id, 'the corrected match from the earlier test');
      assert.equal(d.lines[1].status, 'suggested');
      assert.equal(d.lines[1].stockItemId, strips.id);
      assert.equal(d.lines[2].status, 'unmatched');
      assert.equal(d.lines[3].status, 'skipped');
      assert.equal(d.lines[0].suggestedLocationId, fridge.id, 'where that item was last received');
      assert.equal(d.lines[2].suggestedLocationId, null);
      assert.ok(d.defaultLocationId, 'a store to fall back on');
      assert.ok(d.existing, 'INV 7001 from this supplier is already on file');
      assert.equal(d.existing.itemCount, 2);
      assert.equal(await db.StockActivity.count({ where: { action: 'invoice_read', userId: admin.id, detail: { [Op.like]: `%${TAG}%` } } }), 1);
    } finally {
      reader.readInvoice = real;
    }
  });

  test('deliveries list and detail say how a delivery was entered', async () => {
    const receipts = require('../controllers/stockReceiptController');
    const list = res();
    await receipts.list({ query: { supplierId: String(supplier.id), method: 'invoice' }, user: { id: admin.id } }, list);
    assert.equal(list.statusCode, 200);
    const inv = list.body.data.find((x) => x.number === 'inv 7001');
    assert.ok(inv);
    assert.equal(inv.method, 'invoice');
    const one = res();
    await receipts.getOne({ params: { id: inv.id }, user: { id: admin.id } }, one);
    assert.equal(one.body.data.items[0].receiveMethod, 'invoice');
    assert.deepEqual(one.body.data.items[0].sourceCorrections, ['batchNo']);
  });
});
