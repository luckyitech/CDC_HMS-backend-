// Stock — supplier invoices / receipts and their scans (12 Oct 2026, Emu).
//
// An intake may name an invoice / receipt number (optional since 12 Oct
// afternoon); several items received on one document share one StockReceipt (supplier + normalised
// number). The scan can be added at receiving or later — a receipt with no
// scan is flagged in Movements → Deliveries until one is added, so an audit can
// compare what was recorded as received with what was actually delivered.
//
//   GET    /api/stock/receipts                      list (q, supplierId, from, to, missing=1)
//   GET    /api/stock/receipts/lookup?number&supplierId  the receipt for that number, or null
//   POST   /api/stock/receipts                      find-or-create {number, kind, supplierId}
//   GET    /api/stock/receipts/:id                  one receipt: its items and its scans
//   POST   /api/stock/receipts/:id/documents        attach a scan (multipart 'file')
//   GET    /api/stock/receipts/:id/documents/:docId the scan itself (authenticated)
//   DELETE /api/stock/receipts/:id/documents/:docId soft-remove (stays in the audit trail)

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolveStockReceiptFile } = require('../utils/stockReceiptStorage');
const db = require('../models');

const {
  StockReceipt, StockReceiptDocument, StockBatch, StockItem, StockMovement, StockLocation, Supplier, User,
} = db;

const KINDS = ['invoice', 'receipt', 'delivery_note'];
const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

/** "  inv 0042 " → "INV 0042" — the comparison key, so case and spacing never split one document in two. */
const numberKeyOf = (n) => String(n || '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 80);
const cleanNumber = (n) => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 80);

/**
 * The receipt for this supplier + number, created when it does not exist yet.
 * Used by the intake (inside its transaction) and by POST /receipts (to attach
 * a scan before the first line is saved). Throws { status, message } on bad input.
 */
const findOrCreateReceipt = async ({ number, kind, supplierId, userId }, transaction) => {
  const key = numberKeyOf(number);
  if (!key) { const e = new Error('Enter the invoice / receipt number'); e.status = 400; throw e; }
  const where = { numberKey: key, supplierId: supplierId ? Number(supplierId) : null };
  const found = await StockReceipt.findOne({ where, transaction });
  if (found) return found;
  return StockReceipt.create({
    ...where,
    number: cleanNumber(number),
    kind: KINDS.includes(kind) ? kind : 'invoice',
    createdById: userId,
  }, { transaction });
};

const docOut = (d) => ({
  id: d.id, fileName: d.fileName, mimeType: d.mimeType, fileSize: d.fileSize,
  uploadedAt: d.createdAt, uploadedByName: fullName(d.uploadedByUser),
});

const receiptOut = (r) => {
  const batches = r.batches || [];
  const docs = (r.documents || []).filter((d) => d.status === 'active');
  const received = batches.map((b) => new Date(b.receivedAt).getTime()).filter((n) => !Number.isNaN(n));
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    supplierId: r.supplierId,
    supplierName: r.supplier?.name || null,
    createdAt: r.createdAt,
    createdByName: fullName(r.createdByUser),
    receivedAt: received.length ? new Date(Math.min(...received)) : r.createdAt,
    itemCount: batches.length,
    unitCount: batches.reduce((n, b) => n + (Number(b.qtyReceived) || 0), 0),
    documentCount: docs.length,
    documents: docs.map(docOut),
  };
};

const listIncludes = () => [
  { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
  { model: User, as: 'createdByUser', attributes: ['firstName', 'lastName'] },
  { model: StockBatch, as: 'batches', attributes: ['id', 'qtyReceived', 'receivedAt'] },
  {
    model: StockReceiptDocument, as: 'documents', required: false,
    attributes: ['id', 'fileName', 'mimeType', 'fileSize', 'status', 'createdAt'],
    include: [{ model: User, as: 'uploadedByUser', attributes: ['firstName', 'lastName'] }],
  },
];

/** GET /api/stock/receipts?q&supplierId&from&to&missing=1&limit */
const list = async (req, res) => {
  try {
    const where = {};
    const q = numberKeyOf(req.query.q);
    if (q) where.numberKey = { [Op.like]: `%${q}%` };
    if (req.query.supplierId) where.supplierId = Number(req.query.supplierId);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(`${from}T00:00:00+03:00`);
      if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59+03:00`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const rows = await StockReceipt.findAll({ where, include: listIncludes(), order: [['createdAt', 'DESC']], limit });
    let out = rows.map(receiptOut);
    if (req.query.missing === '1') out = out.filter((r) => r.documentCount === 0);
    return success(res, out);
  } catch (err) {
    console.error('StockReceipt.list error:', err);
    return error(res, 'Failed to load deliveries', 500);
  }
};

/** GET /api/stock/receipts/lookup?number&supplierId — the receive form's "already on file?" */
const lookup = async (req, res) => {
  try {
    const key = numberKeyOf(req.query.number);
    if (!key) return success(res, null);
    const row = await StockReceipt.findOne({
      where: { numberKey: key, supplierId: req.query.supplierId ? Number(req.query.supplierId) : null },
      include: listIncludes(),
    });
    return success(res, row ? receiptOut(row) : null);
  } catch (err) {
    console.error('StockReceipt.lookup error:', err);
    return error(res, 'Failed to look up the invoice', 500);
  }
};

/** POST /api/stock/receipts {number, kind?, supplierId?} — find or create (to attach a scan first). */
const ensure = async (req, res) => {
  try {
    const { number, kind, supplierId } = req.body || {};
    if (supplierId) {
      const s = await Supplier.findByPk(supplierId);
      if (!s || s.status !== 'active') return error(res, 'Supplier not found or retired', 404);
    }
    const row = await findOrCreateReceipt({ number, kind, supplierId, userId: req.user.id });
    const full = await StockReceipt.findByPk(row.id, { include: listIncludes() });
    return success(res, receiptOut(full));
  } catch (err) {
    if (err.status) return error(res, err.message, err.status);
    console.error('StockReceipt.ensure error:', err);
    return error(res, 'Failed to save the invoice number', 500);
  }
};

/** GET /api/stock/receipts/:id — the items received on it and its scans, side by side. */
const getOne = async (req, res) => {
  try {
    const row = await StockReceipt.findByPk(req.params.id, { include: listIncludes() });
    if (!row) return error(res, 'Invoice / receipt not found', 404);
    const batches = await StockBatch.findAll({
      where: { stockReceiptId: row.id },
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'packSize', 'category'] },
        { model: User, as: 'receivedByUser', attributes: ['firstName', 'lastName'] },
      ],
      order: [['receivedAt', 'ASC'], ['id', 'ASC']],
    });
    const intakes = batches.length ? await StockMovement.findAll({
      where: { stockBatchId: { [Op.in]: batches.map((b) => b.id) }, type: 'intake' },
      include: [{ model: StockLocation, as: 'toLocation', attributes: ['id', 'name'] }],
      attributes: ['id', 'stockBatchId'],
    }) : [];
    const locByBatch = Object.fromEntries(intakes.map((m) => [m.stockBatchId, m.toLocation?.name || null]));
    return success(res, {
      ...receiptOut(row),
      items: batches.map((b) => ({
        batchId: b.id,
        itemName: b.item?.name || 'Item',
        unit: b.item?.unit || null,
        packSize: b.item?.packSize || null,
        qtyReceived: b.qtyReceived,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate,
        labelCode: b.labelCode,
        location: locByBatch[b.id] || null,
        receivedAt: b.receivedAt,
        receivedByName: fullName(b.receivedByUser),
      })),
    });
  } catch (err) {
    console.error('StockReceipt.getOne error:', err);
    return error(res, 'Failed to load the delivery', 500);
  }
};

/** POST /api/stock/receipts/:id/documents — multipart 'file' (handled by the route's uploader). */
const addDocument = async (req, res) => {
  try {
    if (!req.file) return error(res, 'Choose a photo or PDF of the document', 400);
    const row = await StockReceipt.findByPk(req.params.id);
    if (!row) return error(res, 'Invoice / receipt not found', 404);
    const doc = await StockReceiptDocument.create({
      stockReceiptId: row.id,
      filePath: req.file.filename,                       // the stored NAME only
      fileName: String(req.file.originalname || 'scan').slice(0, 250),
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedById: req.user.id,                         // from the JWT
    });
    const full = await StockReceiptDocument.findByPk(doc.id, { include: [{ model: User, as: 'uploadedByUser', attributes: ['firstName', 'lastName'] }] });
    return success(res, docOut(full), 201);
  } catch (err) {
    console.error('StockReceipt.addDocument error:', err);
    return error(res, 'Failed to attach the document', 500);
  }
};

/** GET /api/stock/receipts/:id/documents/:docId — streams the scan (never a static URL). */
const getDocument = async (req, res) => {
  try {
    const doc = await StockReceiptDocument.findOne({ where: { id: req.params.docId, stockReceiptId: req.params.id } });
    if (!doc || doc.status !== 'active') return error(res, 'Document not found', 404);
    const file = resolveStockReceiptFile(doc.filePath);
    if (!file) return error(res, 'The file is missing on the server', 404);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/"/g, '')}"`);
    return res.sendFile(file);
  } catch (err) {
    console.error('StockReceipt.getDocument error:', err);
    return error(res, 'Failed to open the document', 500);
  }
};

/** DELETE /api/stock/receipts/:id/documents/:docId — soft: kept for the audit trail. */
const removeDocument = async (req, res) => {
  try {
    const doc = await StockReceiptDocument.findOne({ where: { id: req.params.docId, stockReceiptId: req.params.id } });
    if (!doc || doc.status !== 'active') return error(res, 'Document not found', 404);
    await doc.update({ status: 'removed', removedById: req.user.id, removedAt: new Date() });
    return success(res, { removed: true });
  } catch (err) {
    console.error('StockReceipt.removeDocument error:', err);
    return error(res, 'Failed to remove the document', 500);
  }
};

module.exports = {
  list, lookup, ensure, getOne, addDocument, getDocument, removeDocument,
  findOrCreateReceipt, numberKeyOf, KINDS,
};
