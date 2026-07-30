const db = require('../models');
const { Op, fn, col } = require('sequelize');
const { clinicToday } = require('./clinicTime');

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

// Expired means the expiry date is BEFORE today at the clinic — stock is good
// through the whole of its expiry day. Both sides are 'YYYY-MM-DD' strings, so
// this is a plain lexicographic compare with no timezone conversion (see
// utils/clinicTime for why that matters).
const isExpired = (batch) => !!batch.expiryDate && String(batch.expiryDate) < clinicToday();

// ---------------------------------------------------------------------
// Adjust one StockLevel row inside an open transaction, with a row lock so
// two people dispensing the last box simultaneously cannot go negative.
// ---------------------------------------------------------------------
const adjustLevel = async (stockBatchId, locationId, delta, t) => {
  // Ensure the row exists. Two concurrent creates are expected and safe — the
  // unique index rejects the loser, which then falls through to the locked read
  // below and sees the winner's row.
  //
  // ONLY that collision is swallowed. A blanket catch here also hid foreign-key
  // violations (a bad locationId), validation errors and connection failures,
  // which then resurfaced as the misleading 'could not be created' below with
  // the real cause never reaching the logs.
  try {
    await StockLevel.findOrCreate({
      where: { stockBatchId, locationId },
      defaults: { stockBatchId, locationId, quantity: 0 },
      transaction: t,
    });
  } catch (err) {
    if (err?.name !== 'SequelizeUniqueConstraintError') throw err;
  }

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
  // Lock the movement being reversed, so two reversals of it queue up rather
  // than running side by side.
  const original = await StockMovement.findByPk(movementId, {
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (!original) throw new LedgerError('Movement not found', 404);
  if (original.type === 'reversal') throw new LedgerError('A reversal cannot itself be reversed');

  // Fast path for the ordinary case, giving a clean message without waiting for
  // the database to reject the insert.
  const already = await StockMovement.findOne({
    where: { reversesMovementId: original.id },
    transaction: t,
  });
  if (already) throw new LedgerError('This movement has already been reversed');

  try {
    return await applyMovement({
      type: 'reversal',
      stockBatchId: original.stockBatchId,
      quantity: original.quantity,
      fromLocationId: original.toLocationId,   // swapped — undoes the original
      toLocationId: original.fromLocationId,
      performedById,
      reason,
      reversesMovementId: original.id,
    }, t);
  } catch (err) {
    // The check above cannot be trusted on its own: under REPEATABLE READ two
    // concurrent reversals both read their snapshot before either commits, both
    // see no reversal, and both proceed — crediting the stock twice and
    // inventing units that were never received. The unique index on
    // reversesMovementId is what actually stops the second one; this turns its
    // rejection into the same clean message the fast path gives.
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new LedgerError('This movement has already been reversed');
    }
    throw err;
  }
};

// ---------------------------------------------------------------------
// FEFO — First-Expiry, First-Out (receipt date as tiebreaker). Returns the
// batch the system suggests for an item at a location, or null.
//
// Pass `t` when calling from inside a transaction. It is not optional in
// practice: without it this runs on a SECOND connection from the pool while the
// caller still holds the first, so under load every pooled connection can end
// up held by a transaction waiting for a free connection that will never come —
// the requests then hang until the 30s acquire timeout. It would also read
// outside the transaction and miss the caller's own uncommitted movements.
// ---------------------------------------------------------------------
const suggestFefoBatch = async (stockItemId, locationId, t = null) => {
  const today = clinicToday();
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
    transaction: t,
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
    // Summed in SQL, in two grouped passes (stock leaving a location, stock
    // arriving at one). This used to load EVERY movement ever recorded into
    // memory to add them up in JS — the ledger is append-only, so that set only
    // grows, and the rebuild would eventually be the thing that runs the
    // process out of memory. Both queries now return at most one row per
    // (batch, location), which is the size of the table being rebuilt.
    const sums = (locationField, sign) => StockMovement.findAll({
      where: { [locationField]: { [Op.ne]: null } },
      attributes: [
        'stockBatchId',
        [col(locationField), 'locationId'],
        [fn('SUM', col('quantity')), 'total'],
      ],
      group: ['stockBatchId', locationField],
      raw: true,
      transaction: t,
    }).then((rows) => rows.map((r) => ({ ...r, total: sign * Number(r.total) })));

    const [out, incoming] = await Promise.all([
      sums('fromLocationId', -1),
      sums('toLocationId', 1),
    ]);

    const map = new Map(); // 'batch:location' → qty
    [...out, ...incoming].forEach((r) => {
      const key = `${r.stockBatchId}:${r.locationId}`;
      map.set(key, (map.get(key) || 0) + r.total);
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
