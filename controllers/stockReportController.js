const { success, error } = require('../utils/response');
const db = require('../models');
const { Op } = require('sequelize');

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
    const items = await StockItem.findAll({
      where: { status: 'active', reorderLevel: { [Op.gt]: 0 } },
      attributes: ['id', 'name', 'unit', 'category', 'reorderLevel', 'reorderQuantity'],
      order: [['name', 'ASC']],
    });

    const levels = await StockLevel.findAll({
      where: { quantity: { [Op.gt]: 0 } },
      include: [{ model: StockBatch, as: 'batch', attributes: ['stockItemId'] }],
    });
    const totals = {};
    levels.forEach((l) => {
      const id = l.batch?.stockItemId;
      if (id) totals[id] = (totals[id] || 0) + l.quantity;
    });

    const rows = items
      .map((i) => ({ ...i.toJSON(), totalQuantity: totals[i.id] || 0 }))
      .filter((i) => i.totalQuantity <= i.reorderLevel)
      .map((i) => ({
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
    const from = new Date();
    from.setMonth(from.getMonth() - (months - 1));
    from.setDate(1);
    from.setHours(0, 0, 0, 0);

    const rows = await StockMovement.findAll({
      where: {
        type: { [Op.in]: ['dispense', 'use', 'expiry_writeoff', 'damage_writeoff'] },
        createdAt: { [Op.gte]: from },
      },
      include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit'] }],
      order: [['createdAt', 'ASC']],
    });

    // itemId → { item, months: { 'YYYY-MM': { consumed, writtenOff } } }
    const byItem = {};
    const monthKeys = [];
    for (let i = 0; i < months; i += 1) {
      const d = new Date(from);
      d.setMonth(d.getMonth() + i);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    rows.forEach((m) => {
      if (!m.item) return;
      const key = new Date(m.createdAt).toISOString().slice(0, 7);
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
// matching batch with its full movement history and everywhere it sits now.
// (The "every patient who received it" half activates with the future
// patient-linking phase — the schema already carries PatientId.)
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

      // "Who received it" — unique patients this batch was dispensed to, with
      // the total quantity each got. The half that was stubbed for the
      // patient-linking phase, now live.
      // Both 'dispense' (taken home) and 'use' (administered in the room)
      // count as "received it" for a recall.
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
// when and why (dispense/transfer store the override in the reason prefix).
const fefoOverrides = movementReport('fefoOverrides', () => ({
  reason: { [Op.like]: 'FEFO override:%' },
}));

module.exports = { reorder, consumption, recall, disposal, fefoOverrides };
