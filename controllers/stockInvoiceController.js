// Stock — receiving a delivery from its invoice (13 Oct 2026, Emu).
//
// 1. POST /api/stock/receipts/read          multipart 'file' (+ supplierId?)
//      The photo / PDF is kept in private/stock-receipts/ (the same folder as
//      attached scans) and sent to the reader (utils/invoiceReader). Every line
//      comes back matched to the catalogue (utils/stockItemMatch): remembered
//      (this supplier's wording, StockSupplierAliases), suggested, or unmatched.
//      Nothing is saved. The reply carries `uploadToken` — the stored file —
//      which step 2 attaches as the delivery's scan.
// 2. POST /api/stock/receipts/receive-batch  { uploadToken, supplierId, receiptNo,
//      receiptKind, locationId, lines: [...] }
//      All lines save in ONE transaction (one fails → nothing is saved): the
//      receipt, a batch + label + intake movement per line (utils/stockReceive,
//      the same code as the one-item form), the scan attached, and every
//      confirmed wording remembered for the supplier.
// 3. DELETE /api/stock/receipts/pending/:token   a read that was cancelled —
//      the file goes; a file already attached to a delivery is never touched.
//
// Labels are NOT printed here: staff print them per item after the save
// (Emu, 13 Oct), from the batches this returns.

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');
// Called through the module (reader.readInvoice) so tests can stand in a stub.
const reader = require('../utils/invoiceReader');
const { InvoiceReadError } = reader;
const { matchLine, aliasKeyOf, similarity } = require('../utils/stockItemMatch');
const { validateReceiveLine, receiveLine } = require('../utils/stockReceive');
const { LedgerError } = require('../utils/stockLedger');
const { logStockActivity } = require('../utils/stockAudit');
const { STOCK_RECEIPT_DIR, resolveStockReceiptFile } = require('../utils/stockReceiptStorage');
const { findOrCreateReceipt, numberKeyOf, KINDS } = require('./stockReceiptController');

const {
  sequelize, StockItem, StockLocation, StockMovement, Supplier, StockReceipt, StockReceiptDocument, StockSupplierAlias, StockBatch, User,
} = db;

// The stored name the uploader gives a file: 32 hex + a known extension.
const TOKEN = /^[a-f0-9]{32}\.(pdf|jpe?g|png|webp|heic|heif)$/;
const PENDING_MAX_AGE_MS = 2 * 86400000;
const LINE_FIELDS = ['item', 'batchNo', 'expiryDate', 'quantity'];
const MAX_LINES = 100;

/** Pending reads nobody saved (cancelled, browser closed) — swept on the next read. */
const sweepPendingFiles = async () => {
  try {
    const names = fs.readdirSync(STOCK_RECEIPT_DIR).filter((n) => TOKEN.test(n));
    const old = names.filter((n) => Date.now() - fs.statSync(path.join(STOCK_RECEIPT_DIR, n)).mtimeMs > PENDING_MAX_AGE_MS);
    if (!old.length) return;
    const kept = new Set((await StockReceiptDocument.findAll({ where: { filePath: { [Op.in]: old } }, attributes: ['filePath'] })).map((d) => d.filePath));
    old.filter((n) => !kept.has(n)).forEach((n) => { try { fs.unlinkSync(path.join(STOCK_RECEIPT_DIR, n)); } catch { /* already gone */ } });
  } catch (err) {
    console.error('StockInvoice.sweepPendingFiles error:', err);
  }
};

const supplierMatch = (name, suppliers) => {
  if (!name) return null;
  let best = null;
  for (const s of suppliers) {
    const score = similarity(name, s.name);
    if (score >= 0.6 && (!best || score > best.score)) best = { id: s.id, name: s.name, score };
  }
  return best;
};

/** GET /api/stock/receipts/reader — is reading set up on this server? */
const status = (req, res) => success(res, { configured: reader.isConfigured() });

/** POST /api/stock/receipts/read */
const read = async (req, res) => {
  try {
    if (!req.file) return error(res, 'Choose a photo or PDF of the invoice', 400);
    const buffer = fs.readFileSync(req.file.path);
    const [suppliers, items] = await Promise.all([
      Supplier.findAll({ where: { status: 'active' }, attributes: ['id', 'name'], order: [['name', 'ASC']] }),
      StockItem.findAll({ where: { status: 'active' }, attributes: ['id', 'name', 'unit', 'packSize', 'category', 'requiresColdChain'] }),
    ]);

    const result = await reader.readInvoice({ buffer, mimeType: req.file.mimetype, supplierNames: suppliers.map((s) => s.name) });

    // The supplier: the one chosen on the form, else the one read from the invoice.
    const chosen = req.body.supplierId ? suppliers.find((s) => s.id === Number(req.body.supplierId)) : null;
    const read_ = chosen ? null : supplierMatch(result.supplierName, suppliers);
    const supplierId = chosen?.id || read_?.id || null;

    const aliasRows = await StockSupplierAlias.findAll({ where: { supplierId }, attributes: ['aliasKey', 'stockItemId'] });
    const aliases = new Map(aliasRows.map((a) => [a.aliasKey, a.stockItemId]));

    const lines = result.lines.map((l, i) => ({
      id: i + 1,
      ...l,
      ...(l.isStockItem ? matchLine(l.description, items, aliases) : { status: 'skipped', stockItemId: null, candidates: [] }),
    }));

    // Where each line goes (15 Oct 2026, Emu): every line is put away in its
    // own place at receiving, so nothing needs a transfer afterwards. The
    // suggestion is where that item was last received; otherwise the first
    // store (a fridge for cold-chain items — the front end enforces that).
    const matchedIds = [...new Set(lines.map((l) => l.stockItemId).filter(Boolean))];
    const lastIntakes = matchedIds.length ? await StockMovement.findAll({
      where: { type: 'intake', stockItemId: { [Op.in]: matchedIds } },
      attributes: ['stockItemId', 'toLocationId'], order: [['createdAt', 'DESC']],
    }) : [];
    const lastLocation = {};
    for (const m of lastIntakes) if (!lastLocation[m.stockItemId] && m.toLocationId) lastLocation[m.stockItemId] = m.toLocationId;
    const store = await StockLocation.findOne({ where: { status: 'active', kind: 'store' }, order: [['id', 'ASC']], attributes: ['id'] });
    lines.forEach((l) => { l.suggestedLocationId = l.stockItemId ? (lastLocation[l.stockItemId] || null) : null; });

    // Already on file? (same supplier + number) — so one invoice is never received twice.
    let existing = null;
    if (numberKeyOf(result.documentNumber)) {
      const r = await StockReceipt.findOne({
        where: { numberKey: numberKeyOf(result.documentNumber), supplierId },
        include: [
          { model: StockBatch, as: 'batches', attributes: ['id', 'receivedAt'], include: [{ model: User, as: 'receivedByUser', attributes: ['firstName', 'lastName'] }] },
        ],
      });
      if (r && r.batches.length) {
        const first = r.batches[0];
        existing = {
          id: r.id, itemCount: r.batches.length, receivedAt: first.receivedAt,
          receivedByName: first.receivedByUser ? `${first.receivedByUser.firstName} ${first.receivedByUser.lastName}` : null,
        };
      }
    }

    await logStockActivity({
      action: 'invoice_read', userId: req.user.id,
      detail: [result.documentNumber || 'no number read', chosen?.name || read_?.name || result.supplierName || 'supplier not read', `${lines.filter((l) => l.isStockItem).length} line(s)`].join(' · '),
    });
    sweepPendingFiles();   // best-effort, after the reply's work

    return success(res, {
      uploadToken: req.file.filename,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      supplier: {
        id: supplierId,
        name: chosen?.name || read_?.name || null,
        readAs: result.supplierName,
        matched: Boolean(chosen || read_),
      },
      documentKind: result.documentKind,
      documentNumber: result.documentNumber,
      documentDate: result.documentDate,
      notes: result.notes,
      defaultLocationId: store?.id || null,
      lines,
      existing,
    });
  } catch (err) {
    if (err instanceof InvoiceReadError) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* nothing to remove */ } }
      return error(res, err.message, err.statusCode);
    }
    console.error('StockInvoice.read error:', err);
    return error(res, 'Failed to read the invoice', 500);
  }
};

/** GET /api/stock/receipts/pending/:token — the uploaded file, to show beside the lines. */
const pendingFile = (req, res) => {
  const file = TOKEN.test(req.params.token) ? resolveStockReceiptFile(req.params.token) : null;
  if (!file) return error(res, 'The scan is no longer on the server — read the invoice again', 404);
  return res.sendFile(file);
};

/** DELETE /api/stock/receipts/pending/:token — a cancelled read. */
const discard = async (req, res) => {
  try {
    const { token } = req.params;
    if (!TOKEN.test(token)) return error(res, 'Not a pending scan', 400);
    const attached = await StockReceiptDocument.count({ where: { filePath: token } });
    if (attached) return error(res, 'This scan is attached to a delivery', 409);
    const file = resolveStockReceiptFile(token);
    if (file) fs.unlinkSync(file);
    return success(res, { discarded: true });
  } catch (err) {
    console.error('StockInvoice.discard error:', err);
    return error(res, 'Failed to discard the scan', 500);
  }
};

/** Remember a confirmed wording for the supplier (newest confirmation wins). */
const rememberAlias = async ({ supplierId, text, stockItemId, userId }, transaction) => {
  const aliasKey = aliasKeyOf(text);
  if (!aliasKey) return;
  const where = { supplierId: supplierId || null, aliasKey };
  const row = await StockSupplierAlias.findOne({ where, transaction });
  if (row) {
    await row.update({ stockItemId, aliasText: String(text).slice(0, 160), useCount: row.useCount + 1, lastUsedAt: new Date() }, { transaction });
  } else {
    await StockSupplierAlias.create({ ...where, aliasText: String(text).slice(0, 160), stockItemId, createdById: userId, lastUsedAt: new Date() }, { transaction });
  }
};

/**
 * POST /api/stock/receipts/receive-batch
 * lines: [{ stockItemId, quantity, batchNo?, expiryDate?, locationId, sourceText?, corrections?: ['batchNo', …] }]
 * Each line names where it is put away (locationId falls back to the body's locationId, if any).
 */
const receiveBatch = async (req, res) => {
  try {
    const { uploadToken, supplierId, receiptNo, receiptKind, locationId, lines, fileName } = req.body;
    if (!Array.isArray(lines) || !lines.length) return error(res, 'There are no lines to save');
    if (lines.length > MAX_LINES) return error(res, `Save at most ${MAX_LINES} lines at once`);

    const token = uploadToken && TOKEN.test(uploadToken) ? uploadToken : null;
    const file = token ? resolveStockReceiptFile(token) : null;
    if (token && !file) return error(res, 'The scan is no longer on the server — read the invoice again', 410);
    if (file && await StockReceiptDocument.count({ where: { filePath: token } })) {
      return error(res, 'This invoice has already been saved', 409);
    }

    // Validate every line before the transaction — a clean 400 names the line.
    const checked = [];
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i] || {};
      const qty = parseInt(l.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) return error(res, `Line ${i + 1}: quantity must be a whole number of at least 1`);
      if (l.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.expiryDate)) return error(res, `Line ${i + 1}: expiry must be a date`);
      try {
        if (!l.locationId && !locationId) return error(res, `Line ${i + 1}: choose where it is put away`);
        const { item, location } = await validateReceiveLine({
          stockItemId: l.stockItemId, locationId: l.locationId || locationId, expiryDate: l.expiryDate, supplierId,
        });
        const corrections = Array.isArray(l.corrections) ? l.corrections.filter((f) => LINE_FIELDS.includes(f)) : [];
        checked.push({ item, location, quantity: qty, batchNo: l.batchNo, expiryDate: l.expiryDate || null, sourceText: l.sourceText || null, corrections });
      } catch (err) {
        if (err instanceof LedgerError) return error(res, `Line ${i + 1}: ${err.message}`, err.statusCode);
        throw err;
      }
    }

    const result = await sequelize.transaction(async (t) => {
      const receipt = numberKeyOf(receiptNo)
        ? await findOrCreateReceipt({ number: receiptNo, kind: KINDS.includes(receiptKind) ? receiptKind : 'invoice', supplierId, userId: req.user.id }, t)
        : null;

      const saved = [];
      for (const c of checked) {
        const { batch } = await receiveLine({
          item: c.item, location: c.location, quantity: c.quantity, batchNo: c.batchNo, expiryDate: c.expiryDate,
          supplierId, receiptId: receipt?.id, receivedById: req.user.id,
          receiveMethod: 'invoice', sourceText: c.sourceText, sourceCorrections: c.corrections.length ? c.corrections.join(',') : null,
        }, t);
        if (c.sourceText) await rememberAlias({ supplierId, text: c.sourceText, stockItemId: c.item.id, userId: req.user.id }, t);
        saved.push({
          batchId: batch.id, labelCode: batch.labelCode, batchNo: batch.batchNo, expiryDate: batch.expiryDate,
          quantity: batch.qtyReceived, stockItemId: c.item.id, itemName: c.item.name, unit: c.item.unit, packSize: c.item.packSize,
          location: c.location.name,
        });
      }

      let document = null;
      if (file && receipt) {
        document = await StockReceiptDocument.create({
          stockReceiptId: receipt.id,
          filePath: token,
          fileName: String(fileName || 'invoice').slice(0, 250),
          mimeType: path.extname(token) === '.pdf' ? 'application/pdf' : `image/${path.extname(token).slice(1).replace('jpg', 'jpeg')}`,
          fileSize: fs.statSync(file).size,
          uploadedById: req.user.id,
        }, { transaction: t });
      }
      return { receipt, saved, document };
    });

    return success(res, {
      receipt: result.receipt ? { id: result.receipt.id, number: result.receipt.number, kind: result.receipt.kind } : null,
      scanAttached: Boolean(result.document),
      items: result.saved,
    }, 201);
  } catch (err) {
    if (err instanceof LedgerError) return error(res, err.message, err.statusCode);
    console.error('StockInvoice.receiveBatch error:', err);
    return error(res, 'Failed to save the delivery', 500);
  }
};

module.exports = { status, read, pendingFile, discard, receiveBatch, rememberAlias, supplierMatch };
