// =====================================================================
// Receiving one line of stock (13 Oct 2026). The one place a delivery line
// becomes a batch, its STK- label and its intake movement — used by
// POST /stock/intake (one item at a time) and by receiving from an invoice
// (many lines in one transaction), so the two can never drift apart.
// =====================================================================

const db = require('../models');
const { applyMovement, LedgerError } = require('./stockLedger');

const { StockItem, StockLocation, Supplier, StockBatch } = db;

/**
 * Check the references a line names (the cold-chain rule is the ledger's).
 * Throws LedgerError with a clean status.
 * Returns { item, location } for receiveLine.
 */
const validateReceiveLine = async ({ stockItemId, locationId, expiryDate, supplierId }, transaction = null) => {
  const item = await StockItem.findByPk(stockItemId, { transaction });
  if (!item || item.status !== 'active') throw new LedgerError('Stock item not found or retired', 404);

  const location = await StockLocation.findByPk(locationId, { transaction });
  if (!location || location.status !== 'active') throw new LedgerError('Receiving location not found or retired', 404);

  // Medications must carry an expiry; other categories may be undated.
  if (item.category === 'medication' && !expiryDate) {
    throw new LedgerError(`Expiry date is required for medications (${item.name})`, 400);
  }
  if (supplierId) {
    const supplier = await Supplier.findByPk(supplierId, { transaction });
    if (!supplier || supplier.status !== 'active') throw new LedgerError('Supplier not found or retired', 404);
  }
  return { item, location };
};

/**
 * Create the batch (+ label code) and post the intake movement. Must run
 * inside `transaction`. `item` and `location` come from validateReceiveLine.
 * Extra fields on an invoice line: receiveMethod 'invoice', sourceText,
 * sourceCorrections.
 */
const receiveLine = async ({
  item, location, quantity, batchNo, expiryDate, supplierId, receiptId, receivedAt, receivedById,
  receiveMethod = 'manual', sourceText = null, sourceCorrections = null,
}, transaction) => {
  const batch = await StockBatch.create({
    stockItemId: item.id,
    stockReceiptId: receiptId || null,
    batchNo: batchNo ? String(batchNo).trim().slice(0, 80) : null,
    expiryDate: expiryDate || null,
    supplierId: supplierId || null,
    qtyReceived: parseInt(quantity, 10),
    receivedAt: receivedAt || new Date(),
    receivedById,                        // from the JWT, never the client
    receiveMethod,
    sourceText: sourceText ? String(sourceText).slice(0, 160) : null,
    sourceCorrections: sourceCorrections ? String(sourceCorrections).slice(0, 120) : null,
  }, { transaction });

  // Internal shelf-label barcode — the STK- namespace reserved in
  // barcodeController. Assigned from the id so it is unique by construction.
  await batch.update({ labelCode: `STK-${String(batch.id).padStart(6, '0')}` }, { transaction });

  const movement = await applyMovement({
    type: 'intake',
    stockBatchId: batch.id,
    quantity,
    toLocationId: location.id,
    performedById: receivedById,
  }, transaction);

  return { batch, movement };
};

module.exports = { validateReceiveLine, receiveLine };
