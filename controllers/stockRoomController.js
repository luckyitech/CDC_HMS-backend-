const { success, error } = require('../utils/response');
const db = require('../models');
const { Op } = require('sequelize');
const { applyMovement, LedgerError } = require('../utils/stockLedger');
const { itemLocationTotals } = require('../utils/stockTotals');
const { clinicToday } = require('../utils/clinicTime');

const {
  sequelize, StockItem, StockBatch, StockLevel, StockLocation, StockParLevel, User,
} = db;

// Room balancing: par levels per item per room, the red/amber/green grid,
// the FEFO restock picklist and per-location stocktakes.
//
// Quantity roll-ups come from utils/stockTotals — see the note there on why
// every derived total lives in one place.

// RAG per the design: below min → red; within the bottom fifth of the
// min→max range (or exactly at min) → amber; otherwise green.
const ragStatus = (qty, minQty, maxQty) => {
  if (qty < minQty) return 'red';
  const nearBand = Math.max(1, Math.ceil((maxQty - minQty) * 0.2));
  if (qty <= minQty + nearBand - 1) return 'amber';
  return 'green';
};

// ------------------------------------
// GET /api/stock/par-levels?locationId=
// ------------------------------------
const listParLevels = async (req, res) => {
  try {
    const where = {};
    if (req.query.locationId) where.locationId = req.query.locationId;
    const rows = await StockParLevel.findAll({
      where,
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'category'] },
        { model: StockLocation, as: 'location', attributes: ['id', 'name', 'kind'] },
        { model: User, as: 'updatedByUser', attributes: ['id', 'firstName', 'lastName'] },
      ],
      order: [['locationId', 'ASC']],
    });
    return success(res, rows);
  } catch (err) {
    console.error('Stock.listParLevels error:', err);
    return error(res, 'Failed to load par levels', 500);
  }
};

// ------------------------------------
// PUT /api/stock/par-levels — bulk upsert for one location.
// Body: { locationId, entries: [{ stockItemId, minQty, maxQty }] }
// An entry with minQty 0 AND maxQty 0 removes the par level.
// ------------------------------------
const setParLevels = async (req, res) => {
  try {
    const { locationId, entries } = req.body;
    if (!locationId || !Array.isArray(entries)) {
      return error(res, 'locationId and entries are required');
    }
    const location = await StockLocation.findByPk(locationId);
    if (!location || location.status !== 'active') return error(res, 'Location not found or retired', 404);

    for (const e of entries) {
      const min = parseInt(e.minQty, 10);
      const max = parseInt(e.maxQty, 10);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
        return error(res, 'Each entry needs whole numbers with max ≥ min ≥ 0');
      }
    }

    await sequelize.transaction(async (t) => {
      for (const e of entries) {
        const min = parseInt(e.minQty, 10);
        const max = parseInt(e.maxQty, 10);
        if (min === 0 && max === 0) {
          await StockParLevel.destroy({
            where: { stockItemId: e.stockItemId, locationId },
            transaction: t,
          });
          continue;
        }
        const [row, created] = await StockParLevel.findOrCreate({
          where: { stockItemId: e.stockItemId, locationId },
          defaults: {
            stockItemId: e.stockItemId, locationId,
            minQty: min, maxQty: max, lastUpdatedById: req.user.id,
          },
          transaction: t,
        });
        if (!created) {
          await row.update({ minQty: min, maxQty: max, lastUpdatedById: req.user.id }, { transaction: t });
        }
      }
    });

    return success(res, { message: 'Par levels saved' });
  } catch (err) {
    console.error('Stock.setParLevels error:', err);
    return error(res, 'Failed to save par levels', 500);
  }
};

// ------------------------------------
// POST /api/stock/par-levels/copy — set up a new room from an existing one.
// Body: { fromLocationId, toLocationId } — overwrites the destination.
// ------------------------------------
const copyParLevels = async (req, res) => {
  try {
    const { fromLocationId, toLocationId } = req.body;
    if (!fromLocationId || !toLocationId || fromLocationId === toLocationId) {
      return error(res, 'Choose two different locations');
    }
    // Validate the destination before destroying anything there — setParLevels
    // checks its location and this did not, so a mistyped id silently wiped the
    // destination's par levels and left orphan rows pointing at no location.
    const destination = await StockLocation.findByPk(toLocationId);
    if (!destination || destination.status !== 'active') {
      return error(res, 'Destination location not found or retired', 404);
    }

    const source = await StockParLevel.findAll({ where: { locationId: fromLocationId } });
    if (!source.length) return error(res, 'The source room has no par levels to copy');

    await sequelize.transaction(async (t) => {
      await StockParLevel.destroy({ where: { locationId: toLocationId }, transaction: t });
      await StockParLevel.bulkCreate(
        source.map((p) => ({
          stockItemId: p.stockItemId,
          locationId: toLocationId,
          minQty: p.minQty,
          maxQty: p.maxQty,
          lastUpdatedById: req.user.id,
        })),
        { transaction: t }
      );
    });

    return success(res, { message: `Copied ${source.length} par level(s)` });
  } catch (err) {
    console.error('Stock.copyParLevels error:', err);
    return error(res, 'Failed to copy par levels', 500);
  }
};

// ------------------------------------
// GET /api/stock/room-balance — the grid: rooms as columns, items as rows,
// each cell { qty, min, max, status } (red / amber / green).
// Covers every active non-store location that has at least one par level.
// ------------------------------------
const roomBalance = async (req, res) => {
  try {
    const pars = await StockParLevel.findAll({
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'status'] },
        { model: StockLocation, as: 'location', attributes: ['id', 'name', 'kind', 'status'] },
      ],
    });
    const active = pars.filter((p) => p.item?.status === 'active' && p.location?.status === 'active');

    const rooms = [...new Map(active.map((p) => [p.location.id, p.location])).values()]
      .map((l) => ({ id: l.id, name: l.name, kind: l.kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const items = [...new Map(active.map((p) => [p.item.id, p.item])).values()]
      .map((i) => ({ id: i.id, name: i.name, unit: i.unit }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const totals = await itemLocationTotals(rooms.map((r) => r.id));

    const cells = {}; // `${itemId}:${roomId}` → { qty, min, max, status }
    active.forEach((p) => {
      const qty = totals[`${p.stockItemId}:${p.locationId}`] || 0;
      cells[`${p.stockItemId}:${p.locationId}`] = {
        qty, min: p.minQty, max: p.maxQty, status: ragStatus(qty, p.minQty, p.maxQty),
      };
    });

    return success(res, { rooms, items, cells });
  } catch (err) {
    console.error('Stock.roomBalance error:', err);
    return error(res, 'Failed to load room balance', 500);
  }
};

// ------------------------------------
// GET /api/stock/restock-plan?sourceLocationId=
// Builds the trolley picklist: for every room+item below max, transfers from
// the source location to bring it to max, batches chosen FEFO. Nothing moves
// here — each line the user confirms becomes a POST /transfer; unconfirmed
// lines simply lapse.
// ------------------------------------
const restockPlan = async (req, res) => {
  try {
    const sourceLocationId = parseInt(req.query.sourceLocationId, 10);
    if (!sourceLocationId) return error(res, 'sourceLocationId is required');
    const source = await StockLocation.findByPk(sourceLocationId);
    if (!source || source.status !== 'active') return error(res, 'Source location not found or retired', 404);

    const pars = await StockParLevel.findAll({
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'status', 'requiresColdChain'] },
        { model: StockLocation, as: 'location', attributes: ['id', 'name', 'isColdChain', 'status'] },
      ],
    });
    const wanted = pars.filter((p) =>
      p.item?.status === 'active' &&
      p.location?.status === 'active' &&
      p.locationId !== sourceLocationId
    );

    const totals = await itemLocationTotals();

    // Source stock per item as FEFO-ordered batch queues (undated last).
    const today = clinicToday();
    const sourceLevels = await StockLevel.findAll({
      where: { locationId: sourceLocationId, quantity: { [Op.gt]: 0 } },
      include: [{
        model: StockBatch, as: 'batch',
        where: {
          status: 'active',
          [Op.or]: [{ expiryDate: null }, { expiryDate: { [Op.gte]: today } }],
        },
      }],
    });
    const queues = {}; // itemId → [{ batch, remaining }]
    sourceLevels.forEach((l) => {
      (queues[l.batch.stockItemId] = queues[l.batch.stockItemId] || [])
        .push({ batch: l.batch, remaining: l.quantity });
    });
    Object.values(queues).forEach((q) => q.sort((a, b) => {
      const ax = a.batch.expiryDate || '9999-12-31';
      const bx = b.batch.expiryDate || '9999-12-31';
      if (ax !== bx) return ax < bx ? -1 : 1;
      return new Date(a.batch.receivedAt) - new Date(b.batch.receivedAt);
    }));

    const lines = [];
    const shortfalls = [];
    // Rooms in name order so allocation is deterministic.
    wanted.sort((a, b) => a.location.name.localeCompare(b.location.name));

    wanted.forEach((p) => {
      const have = totals[`${p.stockItemId}:${p.locationId}`] || 0;
      let needed = p.maxQty - have;
      if (needed <= 0) return;
      // Cold-chain guard mirrors the ledger's hard block.
      if (p.item.requiresColdChain && !p.location.isColdChain) return;

      const queue = queues[p.stockItemId] || [];
      for (const slot of queue) {
        if (needed <= 0) break;
        if (slot.remaining <= 0) continue;
        const take = Math.min(slot.remaining, needed);
        slot.remaining -= take;
        needed -= take;
        lines.push({
          stockItemId: p.stockItemId,
          itemName: p.item.name,
          unit: p.item.unit,
          stockBatchId: slot.batch.id,
          labelCode: slot.batch.labelCode,
          batchNo: slot.batch.batchNo,
          expiryDate: slot.batch.expiryDate,
          fromLocationId: sourceLocationId,
          toLocationId: p.locationId,
          toLocationName: p.location.name,
          quantity: take,
        });
      }
      if (needed > 0) {
        shortfalls.push({ itemName: p.item.name, toLocationName: p.location.name, short: needed });
      }
    });

    return success(res, { source: { id: source.id, name: source.name }, lines, shortfalls });
  } catch (err) {
    console.error('Stock.restockPlan error:', err);
    return error(res, 'Failed to build restock plan', 500);
  }
};

// ------------------------------------
// POST /api/stock/stocktake — one confirmed submission per location.
// Body: { locationId, counts: [{ stockBatchId, countedQty }], note?,
//         mode? 'full' | 'partial', startedAt? }
//
// Variances become adjustment movements (ledger rows, reason recorded); matching
// counts write nothing. Runs in ONE transaction — a failed line rolls the whole
// count back rather than leaving it half-applied.
//
// mode 'full' (the default) reconciles the WHOLE location: a batch the system
// holds here that was not scanned is recorded as counted zero, because "we
// looked and it isn't on the shelf" is the finding a stocktake exists to
// produce. Previously those batches were skipped, so a count could never detect
// stock that had gone missing without being scanned.
//
// mode 'partial' keeps the old behaviour for counting one shelf of a big room:
// only the submitted batches are touched.
//
// startedAt (ISO timestamp of when the counter's list was drawn) protects a
// delivery that arrives mid-count: stock that landed here after the count began
// was never on the shelf to be scanned, so zeroing it would erase a legitimate
// receipt. Those are reported as `arrivedDuringCount` and left alone.
// ------------------------------------
const stocktake = async (req, res) => {
  try {
    const { locationId, counts, note, mode = 'full', startedAt } = req.body;
    if (!locationId || !Array.isArray(counts) || counts.length === 0) {
      return error(res, 'locationId and counts are required');
    }
    if (!['full', 'partial'].includes(mode)) {
      return error(res, "mode must be 'full' or 'partial'");
    }
    const cutoff = startedAt ? new Date(startedAt) : null;
    if (cutoff && Number.isNaN(cutoff.getTime())) {
      return error(res, 'startedAt must be a valid date');
    }

    const reasonBase = `Stocktake${note ? `: ${String(note).trim()}` : ''}`;

    const results = await sequelize.transaction(async (t) => {
      // Read the expected quantities INSIDE the transaction, holding the same
      // row locks applyMovement takes. Reading them outside meant a dispense
      // landing between the read and the write made `expected` stale — the
      // adjustment then moved the ledger to the wrong figure AND recorded a
      // variance that never happened, which is worse than no variance at all
      // because the reconciliation reports treat it as fact.
      const levels = await StockLevel.findAll({
        where: { locationId },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      const current = Object.fromEntries(levels.map((l) => [l.stockBatchId, l.quantity]));
      const tally = { adjusted: 0, unchanged: 0, missing: 0, arrivedDuringCount: 0 };
      const scanned = new Set();

      for (const c of counts) {
        const counted = parseInt(c.countedQty, 10);
        if (!Number.isInteger(counted) || counted < 0) {
          throw new LedgerError('Counted quantities must be whole numbers ≥ 0');
        }
        scanned.add(Number(c.stockBatchId));
        const expected = current[c.stockBatchId] || 0;
        const delta = counted - expected;
        if (delta === 0) {
          tally.unchanged += 1;
          continue;
        }
        await applyMovement({
          type: 'adjustment',
          stockBatchId: c.stockBatchId,
          quantity: Math.abs(delta),
          fromLocationId: delta < 0 ? locationId : null,
          toLocationId: delta > 0 ? locationId : null,
          performedById: req.user.id,
          reason: `${reasonBase} (expected ${expected}, counted ${counted})`,
        }, t);
        tally.adjusted += 1;
      }

      // Full count: whatever the system still holds here that nobody scanned is
      // not on the shelf. Recording it as counted zero is the whole point of a
      // full count — it is the only way missing stock ever surfaces.
      if (mode === 'full') {
        for (const lvl of levels) {
          if (lvl.quantity <= 0 || scanned.has(Number(lvl.stockBatchId))) continue;

          // Arrived after the counter drew their list — it was never on the
          // shelf to scan, so leave it be and say so in the response.
          if (cutoff && lvl.updatedAt > cutoff) {
            tally.arrivedDuringCount += 1;
            continue;
          }

          await applyMovement({
            type: 'adjustment',
            stockBatchId: lvl.stockBatchId,
            quantity: lvl.quantity,
            fromLocationId: locationId,
            performedById: req.user.id,
            // Same 'expected X, counted Y' shape the inventory report parses,
            // with the cause spelled out for the variances register.
            reason: `${reasonBase} (expected ${lvl.quantity}, counted 0 — not scanned during full count)`,
          }, t);
          tally.missing += 1;
        }
      }

      return tally;
    });

    const parts = [
      `${results.adjusted} adjustment(s)`,
      `${results.unchanged} matched`,
    ];
    if (results.missing) parts.push(`${results.missing} not found and written down to zero`);
    if (results.arrivedDuringCount) parts.push(`${results.arrivedDuringCount} arrived mid-count and left untouched`);

    return success(res, { message: `Stocktake recorded — ${parts.join(', ')}`, ...results });
  } catch (err) {
    if (err instanceof LedgerError) return error(res, err.message, err.statusCode);
    console.error('Stock.stocktake error:', err);
    return error(res, 'Failed to record stocktake', 500);
  }
};

module.exports = {
  listParLevels,
  setParLevels,
  copyParLevels,
  roomBalance,
  restockPlan,
  stocktake,
};
