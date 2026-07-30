const { success, error } = require('../utils/response');
const db = require('../models');
const { Op, fn, col } = require('sequelize');

const { itemsBelowReorder } = require('../utils/stockTotals');
const { clinicToday, clinicMonthStart, clinicMidnight } = require('../utils/clinicTime');

const {
  StockItem, StockBatch, StockMovement, StockLevel, StockLocation, Supplier, User, Patient,
} = db;

// Reports — all straight reads over the ledger and levels. No money anywhere.

const MOVEMENT_INCLUDE = [
  { model: StockItem,     as: 'item',            attributes: ['id', 'name', 'unit', 'category'] },
  { model: StockBatch,    as: 'batch',           attributes: ['id', 'batchNo', 'labelCode', 'expiryDate'] },
  { model: StockLocation, as: 'fromLocation',    attributes: ['id', 'name'] },
  { model: StockLocation, as: 'toLocation',      attributes: ['id', 'name'] },
  { model: User,          as: 'performedByUser', attributes: ['id', 'firstName', 'lastName'] },
  // Patient a dispense went to — powers the recall report's "who received it"
  // trail. Unaliased belongsTo → the row comes back as movement.Patient.
  { model: Patient,       attributes: ['id', 'uhid', 'firstName', 'lastName'], required: false },
];

// ------------------------------------
// GET /api/stock/reports/reorder — items at/below their reorder level, with
// the suggested order quantity. Exportable client-side.
// ------------------------------------
const reorder = async (req, res) => {
  try {
    // The "below reorder" rule lives in utils/stockTotals so the dashboard card
    // and this report can never disagree again. Only the order suggestion is
    // this report's own.
    const rows = (await itemsBelowReorder()).map((i) => ({
      ...i,
      suggestedOrder: i.reorderQuantity || Math.max(i.reorderLevel * 2 - i.totalQuantity, i.reorderLevel),
    }));

    return success(res, rows);
  } catch (err) {
    console.error('Stock.reports.reorder error:', err);
    return error(res, 'Failed to build reorder report', 500);
  }
};

// ------------------------------------
// GET /api/stock/reports/consumption?months=6
// Units leaving stock (dispense + use + write-offs shown separately) per item
// per calendar month — the honest basis for setting reorder and par levels.
// ------------------------------------
const consumption = async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    // The clinic's calendar months — the buckets below are labelled with clinic
    // dates, so the window they are cut from has to use the same calendar.
    const from = clinicMidnight(clinicMonthStart(months - 1));

    const rows = await StockMovement.findAll({
      where: {
        type: { [Op.in]: ['dispense', 'use', 'expiry_writeoff', 'damage_writeoff'] },
        createdAt: { [Op.gte]: from },
      },
      include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit'] }],
      order: [['createdAt', 'ASC']],
    });

    // itemId → { item, months: { 'YYYY-MM': { consumed, writtenOff } } }
    // Both the column labels and the bucket a movement falls into are the
    // CLINIC's month. Deriving either from toISOString() put anything recorded
    // in the small hours of the 1st into the previous month's column.
    const byItem = {};
    const monthKeys = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      monthKeys.push(clinicMonthStart(i).slice(0, 7));
    }
    rows.forEach((m) => {
      if (!m.item) return;
      const key = clinicToday(new Date(m.createdAt)).slice(0, 7);
      const entry = (byItem[m.item.id] = byItem[m.item.id]
        || { item: m.item, months: Object.fromEntries(monthKeys.map((k) => [k, { consumed: 0, writtenOff: 0 }])) });
      if (!entry.months[key]) entry.months[key] = { consumed: 0, writtenOff: 0 };
      if (m.type === 'dispense' || m.type === 'use') entry.months[key].consumed += m.quantity;
      else entry.months[key].writtenOff += m.quantity;
    });

    return success(res, {
      months: monthKeys,
      items: Object.values(byItem).sort((a, b) => a.item.name.localeCompare(b.item.name)),
    });
  } catch (err) {
    console.error('Stock.reports.consumption error:', err);
    return error(res, 'Failed to build consumption report', 500);
  }
};

// ------------------------------------
// GET /api/stock/reports/recall/:query — batch recall trail.
// Matches manufacturer batch number OR internal label code; returns every
// matching batch with its full movement history, everywhere it sits now, and
// every patient who received it (both 'dispense' and 'use' — see below).
// ------------------------------------
const recall = async (req, res) => {
  try {
    const q = String(req.params.query || '').trim();
    if (!q) return error(res, 'Enter a batch number or label code');

    const batches = await StockBatch.findAll({
      where: { [Op.or]: [{ batchNo: q }, { labelCode: q.toUpperCase() }] },
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit'] },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
        {
          model: StockLevel, as: 'levels',
          where: { quantity: { [Op.gt]: 0 } },
          required: false,
          include: [{ model: StockLocation, as: 'location', attributes: ['id', 'name'] }],
        },
      ],
    });
    if (!batches.length) return error(res, 'No batch matches that number or label', 404);

    const results = await Promise.all(batches.map(async (b) => {
      const movements = await StockMovement.findAll({
        where: { stockBatchId: b.id },
        include: MOVEMENT_INCLUDE,
        order: [['createdAt', 'ASC']],
      });

      // "Who received it" — unique patients this batch reached, with the total
      // quantity each got. Both 'dispense' (taken home) and 'use' (administered
      // in the room) count as "received it" for a recall.
      const byPatient = {};
      movements.forEach((m) => {
        if (!['dispense', 'use'].includes(m.type) || !m.Patient) return;
        const p = m.Patient;
        byPatient[p.id] = byPatient[p.id]
          || { uhid: p.uhid, name: `${p.firstName} ${p.lastName}`, quantity: 0 };
        byPatient[p.id].quantity += m.quantity;
      });

      return {
        batch: {
          id: b.id, labelCode: b.labelCode, batchNo: b.batchNo, expiryDate: b.expiryDate,
          status: b.status, qtyReceived: b.qtyReceived, receivedAt: b.receivedAt,
          supplier: b.supplier?.name || null,
        },
        item: b.item,
        currentLocations: (b.levels || []).map((l) => ({ name: l.location?.name, quantity: l.quantity })),
        recipients: Object.values(byPatient),
        movements,
      };
    }));

    return success(res, results);
  } catch (err) {
    console.error('Stock.reports.recall error:', err);
    return error(res, 'Failed to build recall report', 500);
  }
};

// The newest movement per item matching `where`, at most one row per item.
//
// Two queries rather than one correlated subquery: the first groups to find the
// newest timestamp per item (rows = number of items), the second fetches just
// those rows. Both stay proportional to the catalogue, not to the movement
// history, which is the point — the history only ever grows.
const latestPerItem = async (where, attributes) => {
  const newest = await StockMovement.findAll({
    where,
    attributes: ['stockItemId', [fn('MAX', col('createdAt')), 'latestAt']],
    group: ['stockItemId'],
    raw: true,
  });
  if (!newest.length) return [];

  return StockMovement.findAll({
    where: {
      ...where,
      [Op.or]: newest.map((r) => ({ stockItemId: r.stockItemId, createdAt: r.latestAt })),
    },
    attributes,
    order: [['createdAt', 'DESC']],
  });
};

// Shared: filtered movement report (disposal register, FEFO overrides).
const movementReport = (label, whereBuilder) => async (req, res) => {
  try {
    const where = whereBuilder(req);
    if (req.query.from || req.query.to) {
      where.createdAt = {};
      if (req.query.from) where.createdAt[Op.gte] = new Date(req.query.from);
      if (req.query.to) where.createdAt[Op.lte] = new Date(`${req.query.to}T23:59:59`);
    }
    const rows = await StockMovement.findAll({
      where,
      include: MOVEMENT_INCLUDE,
      order: [['createdAt', 'DESC']],
      limit: 500,
    });
    return success(res, rows);
  } catch (err) {
    console.error(`Stock.reports.${label} error:`, err);
    return error(res, `Failed to build ${label} report`, 500);
  }
};

// GET /api/stock/reports/disposal — every write-off with reason: the
// disposal register an inspector asks for.
const disposal = movementReport('disposal', () => ({
  type: { [Op.in]: ['expiry_writeoff', 'damage_writeoff'] },
}));

// GET /api/stock/reports/fefo-overrides — who bypassed the suggested batch,
// when and why (every dispensing path stores the override in the reason prefix).
//
// No colon in the pattern: the blocking paths write 'FEFO override: <reason>'
// but the advisory ones write 'FEFO override (use): …' / '(checkout): …', and
// matching on the colon dropped those — which was most of them, since use and
// checkout are the higher-volume paths.
const fefoOverrides = movementReport('fefoOverrides', () => ({
  reason: { [Op.like]: 'FEFO override%' },
}));

// GET /api/stock/reports/variances — every stock adjustment: stocktake variances
// (the reason carries "expected X, counted Y") and manual count corrections.
// This is the reconciliation record — what the counts disagreed on, at which
// location, corrected by whom and when. Each adjustment IS the reconciliation:
// it moves the ledger to the counted figure.
const variances = movementReport('variances', () => ({ type: 'adjustment' }));

// ------------------------------------
// GET /api/stock/reports/inventory — the master inventory sheet: every active
// item in one place with total availability, where it sits (per location), its
// reorder level, its most recent order (intake qty + date), and its most recent
// stocktake (counted, expected, variance, reason). The single screen to view
// and analyse the whole inventory; also the richest sheet in the Excel export.
// ------------------------------------
const inventory = async (req, res) => {
  try {
    const items = await StockItem.findAll({
      where: { status: 'active' },
      attributes: ['id', 'name', 'category', 'unit', 'reorderLevel', 'reorderQuantity'],
      order: [['name', 'ASC']],
    });

    // Total + per-location quantities.
    const levels = await StockLevel.findAll({
      where: { quantity: { [Op.gt]: 0 } },
      include: [
        { model: StockBatch, as: 'batch', attributes: ['stockItemId'] },
        { model: StockLocation, as: 'location', attributes: ['id', 'name'] },
      ],
    });
    const totals = {};       // itemId → total
    const byLocation = {};   // itemId → { locationName → qty }
    levels.forEach((l) => {
      const id = l.batch?.stockItemId;
      if (!id) return;
      totals[id] = (totals[id] || 0) + l.quantity;
      const name = l.location?.name || '—';
      byLocation[id] = byLocation[id] || {};
      byLocation[id][name] = (byLocation[id][name] || 0) + l.quantity;
    });

    // Most recent order (intake) per item, and most recent stocktake variance
    // per item. Both used to pull EVERY matching movement ever recorded and
    // discard all but the newest per item in JS — a full scan that grows
    // without bound for the life of the clinic. latestPerItem does the
    // narrowing in SQL, so the result set is at most one row per item.
    const [intakes, adjustments] = await Promise.all([
      latestPerItem({ type: 'intake' }, ['stockItemId', 'quantity', 'createdAt']),
      latestPerItem(
        { type: 'adjustment', reason: { [Op.like]: 'Stocktake%' } },
        ['stockItemId', 'quantity', 'reason', 'createdAt', 'toLocationId']
      ),
    ]);

    const lastOrder = {};
    intakes.forEach((m) => {
      lastOrder[m.stockItemId] = { quantity: m.quantity, date: m.createdAt };
    });

    const lastStocktake = {};
    adjustments.forEach((m) => {
      if (lastStocktake[m.stockItemId]) return;
      const match = /expected\s+(\d+),\s*counted\s+(\d+)/i.exec(m.reason || '');
      const expected = match ? Number(match[1]) : null;
      const counted = match ? Number(match[2]) : null;
      const variance = expected != null && counted != null
        ? counted - expected
        : (m.toLocationId ? m.quantity : -m.quantity);
      lastStocktake[m.stockItemId] = { date: m.createdAt, expected, counted, variance, reason: m.reason };
    });

    const rows = items.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      unit: i.unit,
      reorderLevel: i.reorderLevel,
      reorderQuantity: i.reorderQuantity,
      totalQuantity: totals[i.id] || 0,
      locations: Object.entries(byLocation[i.id] || {})
        .map(([name, quantity]) => ({ name, quantity }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      lastOrder: lastOrder[i.id] || null,
      lastStocktake: lastStocktake[i.id] || null,
    }));

    return success(res, rows);
  } catch (err) {
    console.error('Stock.reports.inventory error:', err);
    return error(res, 'Failed to build inventory report', 500);
  }
};

module.exports = { reorder, consumption, recall, disposal, fefoOverrides, variances, inventory };
