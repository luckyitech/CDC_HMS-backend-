const db = require('../models');
const { Op } = require('sequelize');
const { applyMovement, LedgerError } = require('./stockLedger');
const { clinicToday } = require('./clinicTime');

const { StockItem, StockBatch, StockMovement, StockLevel, StockLocation, StockBatchEdit } = db;

// =====================================================================
// Correcting a received delivery line (13 Oct 2026, Emu: "errors in receiving
// need a way to remedy it … show that it was edited and what was edited").
//
// One StockBatch = one received line. Editable: the item, the quantity
// received, the batch number and the expiry date. A reason is required. Each
// edit is kept as a StockBatchEdit (who, when, why, [{ field, from, to }]) and
// the line shows "Edited".
//
//   item      — only while nothing has left the line (no movement other than
//               the intake and earlier corrections), or the history would name
//               the wrong item. Otherwise: return it / receive the right item.
//   quantity  — the difference is a 'receipt_correction' movement into / out of
//               the location the line was received into, so levels stay
//               ledger-true. Down only by what is still held there; 0 cancels
//               a line received in error.
//   expiry    — also puts the batch's expired / active status right.
//
// Runs inside the caller's transaction.
// =====================================================================

const MIN_REASON = 3;
const norm = (v) => (v === undefined ? undefined : (v === null || String(v).trim() === '' ? null : String(v).trim()));

const editReceivedLine = async ({ stockBatchId, changes = {}, reason, userId }, t) => {
  if (String(reason || '').trim().length < MIN_REASON) throw new LedgerError('Give a reason for the correction');

  const batch = await StockBatch.findByPk(stockBatchId, {
    include: [{ model: StockItem, as: 'item' }],
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (!batch) throw new LedgerError('Received line not found', 404);

  const intake = await StockMovement.findOne({
    where: { stockBatchId: batch.id, type: 'intake' },
    order: [['id', 'ASC']],
    transaction: t,
  });
  if (!intake) throw new LedgerError('This line has no receiving record to correct');
  const intakeLocationId = intake.toLocationId;

  const diffs = [];
  let item = batch.item;

  // ---- item ----
  if (changes.stockItemId !== undefined && Number(changes.stockItemId) !== batch.stockItemId) {
    const moved = await StockMovement.count({
      where: { stockBatchId: batch.id, type: { [Op.notIn]: ['intake', 'receipt_correction'] } },
      transaction: t,
    });
    if (moved > 0) {
      throw new LedgerError('Stock has already left this line, so its item cannot be changed. '
        + 'Return what is left and receive the right item instead.');
    }
    const next = await StockItem.findByPk(changes.stockItemId, { transaction: t });
    if (!next || next.status !== 'active') throw new LedgerError('Item not found or retired', 404);
    if (next.requiresColdChain) {
      const loc = await StockLocation.findByPk(intakeLocationId, { transaction: t });
      if (!loc?.isColdChain) throw new LedgerError(`${next.name} requires cold chain — ${loc?.name || 'the receiving location'} is not a fridge location`);
    }
    diffs.push({ field: 'item', from: batch.item?.name || null, to: next.name });
    await batch.update({ stockItemId: next.id }, { transaction: t });
    // The movements carry the item too (denormalised) — keep them true.
    await StockMovement.update({ stockItemId: next.id }, { where: { stockBatchId: batch.id }, transaction: t });
    item = next;
  }

  // ---- batch number ----
  const batchNo = norm(changes.batchNo);
  if (batchNo !== undefined && batchNo !== (batch.batchNo || null)) {
    diffs.push({ field: 'batchNo', from: batch.batchNo || null, to: batchNo });
    await batch.update({ batchNo }, { transaction: t });
  }

  // ---- expiry ----
  const expiryDate = norm(changes.expiryDate);
  if (expiryDate !== undefined && expiryDate !== (batch.expiryDate || null)) {
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new LedgerError('Expiry date must be a date');
    diffs.push({ field: 'expiryDate', from: batch.expiryDate || null, to: expiryDate });
    await batch.update({ expiryDate }, { transaction: t });
  }
  if (item?.category === 'medication' && !batch.expiryDate) {
    throw new LedgerError('Expiry date is required for medications');
  }

  // ---- quantity ----
  if (changes.quantity !== undefined && changes.quantity !== null && changes.quantity !== '') {
    const qty = Number(changes.quantity);
    if (!Number.isInteger(qty) || qty < 0) throw new LedgerError('Quantity must be a whole number, 0 or more');
    const delta = qty - batch.qtyReceived;
    if (delta !== 0) {
      await applyMovement({
        type: 'receipt_correction',
        stockBatchId: batch.id,
        quantity: Math.abs(delta),
        toLocationId: delta > 0 ? intakeLocationId : null,
        fromLocationId: delta < 0 ? intakeLocationId : null,
        performedById: userId,
        reason: `Delivery corrected ${batch.qtyReceived} → ${qty}: ${String(reason).trim()}`,
      }, t);
      diffs.push({ field: 'quantity', from: batch.qtyReceived, to: qty });
      await batch.update({ qtyReceived: qty }, { transaction: t });
    }
  }

  if (diffs.length === 0) throw new LedgerError('Nothing was changed');

  // Expired / active status follows the (possibly corrected) expiry date.
  await batch.reload({ transaction: t });
  if (batch.status !== 'recalled') {
    const held = (await StockLevel.sum('quantity', { where: { stockBatchId: batch.id }, transaction: t })) || 0;
    const expired = !!batch.expiryDate && String(batch.expiryDate) < clinicToday();
    const status = held === 0 ? 'depleted' : (expired ? 'expired' : 'active');
    if (status !== batch.status) await batch.update({ status }, { transaction: t });
  }

  return StockBatchEdit.create({
    stockBatchId: batch.id,
    editedById: userId,              // from the JWT, never the client
    reason: String(reason).trim(),
    changes: diffs,
  }, { transaction: t });
};

module.exports = { editReceivedLine };
