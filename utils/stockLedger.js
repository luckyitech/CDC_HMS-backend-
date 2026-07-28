const db = require('../models');
const { Op } = require('sequelize');

const { StockItem, StockBatch, StockMovement, StockLevel, StockLocation, sequelize } = db;

// =====================================================================
// The stock ledger engine — ONE code path for every movement type.
//
// StockMovement is the append-only source of truth; StockLevel is the
// materialized (batch, location) → quantity convenience updated in the SAME
// transaction. Direction is uniform: every movement optionally has a
// fromLocationId (decremented) and a toLocationId (incremented). The type
// only decides which ends are required and which safety rules apply:
//
//   intake            → to only        (stock enters the world)
//   dispense | use    → from only      (stock leaves the world)
//   expiry_writeoff | damage_writeoff → from only
//   transfer          → from + to
//   adjustment        → from OR to     (count down / count up, reason required)
//   return            → to only        (stock comes back)
//   reversal          → mirror of the reversed movement (computed here)
//
// New movement types need a row in MOVEMENT_RULES — nothing else changes.
// =====================================================================

const MOVEMENT_RULES = {
  intake:           { from: 'forbidden', to: 'required'  },
  dispense:         { from: 'required',  to: 'forbidden' },
  use:              { from: 'required',  to: 'forbidden' },
  transfer:         { from: 'required',  to: 'required'  },
  adjustment:       { from: 'either',    to: 'either',    reasonRequired: true },
  expiry_writeoff:  { from: 'required',  to: 'forbidden', reasonRequired: true },
  damage_writeoff:  { from: 'required',  to: 'forbidden', reasonRequired: true },
  return:           { from: 'forbidden', to: 'required'  },
  reversal:         { from: 'either',    to: 'either',    reasonRequired: true },
};

// Errors the controllers translate to clean 400s (vs unexpected 500s).
class LedgerError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'LedgerError';
    this.statusCode = statusCode;
  }
}

const isExpired = (batch) =>
  !!batch.expiryDate && new Date(batch.expiryDate) < new Date(new Date().toDateString());

// ---------------------------------------------------------------------
// Adjust one StockLevel row inside an open transaction, with a row lock so
// two people dispensing the last box simultaneously cannot go negative.
// ---------------------------------------------------------------------
const adjustLevel = async (stockBatchId, locationId, delta, t) => {
  // Ensure the row exists (unique index makes concurrent creates safe — the
  // loser of the race falls through to the locked read below).
  await StockLevel.findOrCreate({
    where: { stockBatchId, locationId },
    defaults: { stockBatchId, locationId, quantity: 0 },
    transaction: t,
  }).catch(() => {});

  const level = await StockLevel.findOne({
    where: { stockBatchId, locationId },
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (!level) throw new LedgerError('Stock level row could not be created');

  const next = level.quantity + delta;
  if (next < 0) {
    throw new LedgerError(
      `Insufficient stock: only ${level.quantity} unit(s) of this batch at this location (needed ${-delta}).`
    );
  }
  await level.update({ quantity: next }, { transaction: t });
  return next;
};

// Total remaining units of a batch across all locations (inside transaction).
const batchTotal = async (stockBatchId, t) =>
  (await StockLevel.sum('quantity', { where: { stockBatchId }, transaction: t })) || 0;

// ---------------------------------------------------------------------
// applyMovement — validates, adjusts levels, writes the ledger row and keeps
// batch status in sync, all inside the caller's transaction.
// Returns the created StockMovement.
// ---------------------------------------------------------------------
const applyMovement = async ({
  type,
  stockBatchId,
  quantity,
  fromLocationId = null,
  toLocationId = null,
  performedById,
  reason = null,
  PatientId = null,
  prescriptionId = null,
  reversesMovementId = null,
}, t) => {
  const rules = MOVEMENT_RULES[type];
  if (!rules) throw new LedgerError(`Unknown movement type '${type}'`);

  const qty = parseInt(quantity, 10);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new LedgerError('Quantity must be a whole number greater than zero');
  }

  if (rules.from === 'required' && !fromLocationId) throw new LedgerError(`'${type}' requires a source location`);
  if (rules.from === 'forbidden' && fromLocationId) throw new LedgerError(`'${type}' cannot have a source location`);
  if (rules.to === 'required' && !toLocationId) throw new LedgerError(`'${type}' requires a destination location`);
  if (rules.to === 'forbidden' && toLocationId) throw new LedgerError(`'${type}' cannot have a destination location`);
  if (!fromLocationId && !toLocationId) throw new LedgerError('A movement must touch at least one location');
  if (rules.reasonRequired && !String(reason || '').trim()) {
    throw new LedgerError(`A reason is required for '${type}'`);
  }

  const batch = await StockBatch.findByPk(stockBatchId, {
    include: [{ model: StockItem, as: 'item' }],
    transaction: t,
  });
  if (!batch) throw new LedgerError('Batch not found', 404);
  if (batch.status === 'recalled') throw new LedgerError('This batch is recalled — no movements allowed');

  // Expired stock may only be written off or reversed — never dispensed,
  // used or transferred onward.
  if (isExpired(batch) && !['expiry_writeoff', 'reversal', 'adjustment'].includes(type)) {
    throw new LedgerError(
      `Batch ${batch.labelCode || batch.id} expired on ${batch.expiryDate} — write it off instead`
    );
  }

  // Cold-chain guard: a requiresColdChain item may only be placed in a
  // cold-chain location (hard block, per the design).
  if (toLocationId && batch.item?.requiresColdChain) {
    const dest = await StockLocation.findByPk(toLocationId, { transaction: t });
    if (!dest) throw new LedgerError('Destination location not found', 404);
    if (!dest.isColdChain) {
      throw new LedgerError(`${batch.item.name} requires cold chain — ${dest.name} is not a fridge location`);
    }
  }

  // Levels — decrement first so a shortfall aborts before anything is written.
  if (fromLocationId) await adjustLevel(batch.id, fromLocationId, -qty, t);
  if (toLocationId) await adjustLevel(batch.id, toLocationId, qty, t);

  const movement = await StockMovement.create({
    type,
    stockItemId: batch.stockItemId,
    stockBatchId: batch.id,
    quantity: qty,
    fromLocationId,
    toLocationId,
    PatientId,
    prescriptionId,
    performedById,
    reason: reason ? String(reason).trim() : null,
    reversesMovementId,
  }, { transaction: t });

  // Keep batch status honest: depleted when nothing remains anywhere,
  // active again if a reversal/return brings stock back.
  const remaining = await batchTotal(batch.id, t);
  if (remaining === 0 && batch.status === 'active') {
    await batch.update({ status: 'depleted' }, { transaction: t });
  } else if (remaining > 0 && batch.status === 'depleted') {
    await batch.update({ status: 'active' }, { transaction: t });
  }

  return movement;
};

// ---------------------------------------------------------------------
// reverseMovement — the ONLY correction mechanism (ledger rows are immutable).
// Writes a 'reversal' row with from/to swapped, restoring the levels the
// original movement changed.
// ---------------------------------------------------------------------
const reverseMovement = async (movementId, performedById, reason, t) => {
  const original = await StockMovement.findByPk(movementId, { transaction: t });
  if (!original) throw new LedgerError('Movement not found', 404);
  if (original.type === 'reversal') throw new LedgerError('A reversal cannot itself be reversed');

  const already = await StockMovement.findOne({
    where: { reversesMovementId: original.id },
    transaction: t,
  });
  if (already) throw new LedgerError('This movement has already been reversed');

  return applyMovement({
    type: 'reversal',
    stockBatchId: original.stockBatchId,
    quantity: original.quantity,
    fromLocationId: original.toLocationId,   // swapped — undoes the original
    toLocationId: original.fromLocationId,
    performedById,
    reason,
    reversesMovementId: original.id,
  }, t);
};

// ---------------------------------------------------------------------
// FEFO — First-Expiry, First-Out (receipt date as tiebreaker). Returns the
// batch the system suggests for an item at a location, or null.
// ---------------------------------------------------------------------
const suggestFefoBatch = async (stockItemId, locationId) => {
  const today = new Date().toISOString().slice(0, 10);
  const levels = await StockLevel.findAll({
    where: { locationId, quantity: { [Op.gt]: 0 } },
    include: [{
      model: StockBatch,
      as: 'batch',
      where: {
        stockItemId,
        status: 'active',
        [Op.or]: [{ expiryDate: null }, { expiryDate: { [Op.gte]: today } }],
      },
    }],
  });
  if (!levels.length) return null;

  levels.sort((a, b) => {
    const ax = a.batch.expiryDate || '9999-12-31';
    const bx = b.batch.expiryDate || '9999-12-31';
    if (ax !== bx) return ax < bx ? -1 : 1;
    return new Date(a.batch.receivedAt) - new Date(b.batch.receivedAt);
  });
  const best = levels[0];
  return { batch: best.batch, available: best.quantity };
};

// ---------------------------------------------------------------------
// rebuildLevels — admin escape hatch: recompute every StockLevel from the
// ledger. Proof that the ledger is authoritative.
// ---------------------------------------------------------------------
const rebuildLevels = async () => {
  return sequelize.transaction(async (t) => {
    const movements = await StockMovement.findAll({ order: [['id', 'ASC']], transaction: t });
    const map = new Map(); // 'batch:location' → qty
    const bump = (batchId, locId, delta) => {
      const key = `${batchId}:${locId}`;
      map.set(key, (map.get(key) || 0) + delta);
    };
    movements.forEach((m) => {
      if (m.fromLocationId) bump(m.stockBatchId, m.fromLocationId, -m.quantity);
      if (m.toLocationId) bump(m.stockBatchId, m.toLocationId, m.quantity);
    });

    await StockLevel.destroy({ where: {}, transaction: t });
    const rows = [...map.entries()].map(([key, quantity]) => {
      const [stockBatchId, locationId] = key.split(':').map(Number);
      return { stockBatchId, locationId, quantity };
    });
    if (rows.length) await StockLevel.bulkCreate(rows, { transaction: t });
    return rows.length;
  });
};

module.exports = {
  applyMovement,
  reverseMovement,
  suggestFefoBatch,
  rebuildLevels,
  LedgerError,
  MOVEMENT_RULES,
};
