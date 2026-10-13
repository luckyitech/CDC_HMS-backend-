const { success, error } = require('../utils/response');
const db = require('../models');
const { Op, fn, col } = require('sequelize');

const { itemsBelowReorder } = require('../utils/stockTotals');
const { clinicToday, clinicMonthStart, clinicMidnight } = require('../utils/clinicTime');
const { summariseExpiry } = require('../utils/expiryReport');
const { collectStockRows, RESTOCK_REASON } = require('../utils/stockAudit');
const { buildSessions, buildPeople } = require('../utils/stockAuditReport');

const {
  StockItem, StockBatch, StockMovement, StockLevel, StockLocation, Supplier, User, Patient,
  StockActivity, StockParLevel, StockReceipt,
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
      // Of the consumption, how much went to walk-ins (not registered patients).
      if (m.type === 'dispense' && m.recipientName) entry.walkIn = (entry.walkIn || 0) + m.quantity;
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
        if (!['dispense', 'use'].includes(m.type)) return;
        // Walk-ins (13 Oct 2026) are recipients too — a recall must reach them.
        if (!m.Patient && m.recipientName) {
          const k = `walkin:${m.recipientName}|${m.recipientPhone || ''}`;
          byPatient[k] = byPatient[k]
            || { uhid: null, walkIn: true, name: m.recipientName, phone: m.recipientPhone || null, quantity: 0 };
          byPatient[k].quantity += m.quantity;
          return;
        }
        if (!m.Patient) return;
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

// GET /api/stock/reports/walk-ins — dispensing to walk-ins: people not
// registered at the clinic who came in for supplies (13 Oct 2026, Emu).
const walkIns = movementReport('walkIns', () => ({
  type: 'dispense', recipientName: { [Op.ne]: null },
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

// ------------------------------------
// GET /api/stock/reports/expiry?from=YYYY-MM-DD&to=YYYY-MM-DD
// Batches whose EXPIRY DATE falls in the range (past or future), what became
// of each (on shelf / expired on shelf / written off / used up) and a line per
// expiry month. Default range: this month and the next two. The maths lives in
// utils/expiryReport (unit-tested).
// ------------------------------------
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPIRY_SPAN_DAYS = 1100;   // ~3 years

const expiry = async (req, res) => {
  try {
    const today = clinicToday();
    // Last day of the month `add` months after today's clinic month.
    const monthEnd = (add) => {
      const [y, m] = today.split('-').map(Number);
      return new Date(Date.UTC(y, m + add, 0, 12)).toISOString().slice(0, 10);
    };
    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : clinicMonthStart(0);
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : monthEnd(2);
    if (from > to) return error(res, 'The start date is after the end date', 400);
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_EXPIRY_SPAN_DAYS) {
      return error(res, 'Choose a range of three years or less', 400);
    }

    const batches = await StockBatch.findAll({
      where: { expiryDate: { [Op.between]: [from, to] } },
      attributes: ['id', 'batchNo', 'labelCode', 'expiryDate', 'qtyReceived'],
      include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'category'] }],
      order: [['expiryDate', 'ASC'], ['id', 'ASC']],
      limit: 2000,
    });
    const ids = batches.map((b) => b.id);

    const [levels, writeoffs] = ids.length ? await Promise.all([
      StockLevel.findAll({
        where: { stockBatchId: { [Op.in]: ids }, quantity: { [Op.gt]: 0 } },
        attributes: ['stockBatchId', 'quantity'],
        include: [{ model: StockLocation, as: 'location', attributes: ['name'] }],
      }),
      StockMovement.findAll({
        where: { stockBatchId: { [Op.in]: ids }, type: { [Op.in]: ['expiry_writeoff', 'damage_writeoff', 'supplier_return'] } },
        attributes: ['stockBatchId', 'type', [fn('SUM', col('quantity')), 'qty']],
        group: ['stockBatchId', 'type'],
        raw: true,
      }),
    ]) : [[], []];

    const report = summariseExpiry({
      today,
      batches,
      levels: levels.map((l) => ({ stockBatchId: l.stockBatchId, quantity: l.quantity, locationName: l.location?.name })),
      writeoffs,
    });
    return success(res, { from, to, today, truncated: batches.length === 2000, ...report });
  } catch (err) {
    console.error('Stock.reports.expiry error:', err);
    return error(res, 'Failed to build expiry report', 500);
  }
};

// ------------------------------------
// GET /api/stock/reports/audit?from=&to=&userId=&fn=   (13 Oct 2026, Emu)
// When receiving, stocktakes and room balancing took place and by whom — for
// tracking the functions, setting schedules and planning around leave — plus
// every timestamped stock event in the range. `lastDone` is all-time.
// fn: receiving | dispense | transfer | rooms | returns | stocktake | writeoff | items | tests | other
// ------------------------------------
const MAX_AUDIT_SPAN_DAYS = 366;
const MAX_AUDIT_EVENTS = 1500;
const who = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : null);
const USER_ATTRS = ['id', 'firstName', 'lastName', 'role'];

const auditLastDone = async () => {
  const [locations, stocktakes, lastIntake, restocks, parRooms] = await Promise.all([
    StockLocation.findAll({ where: { status: 'active' }, attributes: ['id', 'name', 'kind'], order: [['name', 'ASC']] }),
    StockActivity.findAll({
      where: { action: 'stocktake' },
      include: [{ model: User, as: 'user', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']], limit: 2000,
    }),
    StockMovement.findOne({
      where: { type: 'intake' },
      include: [
        { model: User, as: 'performedByUser', attributes: USER_ATTRS },
        { model: StockBatch, as: 'batch', attributes: ['id'], include: [
          { model: StockReceipt, as: 'receipt', attributes: ['number'] },
          { model: Supplier, as: 'supplier', attributes: ['name'] },
        ] },
      ],
      order: [['createdAt', 'DESC']],
    }),
    StockMovement.findAll({
      where: { type: 'transfer', reason: { [Op.like]: `${RESTOCK_REASON}%` } },
      include: [{ model: User, as: 'performedByUser', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']], limit: 2000,
    }),
    StockParLevel.findAll({ attributes: ['locationId'], group: ['locationId'], raw: true }),
  ]);

  const lastBy = (rows, key) => {
    const out = {};
    for (const r of rows) if (!out[r[key]]) out[r[key]] = r;
    return out;
  };
  const counted = lastBy(stocktakes, 'locationId');
  const restocked = lastBy(restocks, 'toLocationId');
  const rooms = new Set(parRooms.map((p) => p.locationId));

  return {
    stocktake: locations.map((l) => ({
      locationId: l.id, location: l.name, kind: l.kind,
      at: counted[l.id]?.createdAt || null, staff: who(counted[l.id]?.user), detail: counted[l.id]?.detail || null,
    })),
    receiving: lastIntake ? {
      at: lastIntake.createdAt, staff: who(lastIntake.performedByUser),
      receipt: lastIntake.batch?.receipt?.number || null, supplier: lastIntake.batch?.supplier?.name || null,
    } : null,
    restock: locations.filter((l) => rooms.has(l.id)).map((l) => ({
      locationId: l.id, location: l.name, kind: l.kind,
      at: restocked[l.id]?.createdAt || null, staff: who(restocked[l.id]?.performedByUser),
    })),
  };
};

const audit = async (req, res) => {
  try {
    const today = clinicToday();
    const from = ISO_DATE.test(req.query.from || '') ? req.query.from : clinicToday(new Date(Date.now() - 29 * 86400000));
    const to = ISO_DATE.test(req.query.to || '') ? req.query.to : today;
    if (from > to) return error(res, 'The start date is after the end date', 400);
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_AUDIT_SPAN_DAYS) {
      return error(res, 'Choose a range of a year or less', 400);
    }
    const end = new Date(clinicMidnight(to).getTime() + 86400000);
    const dateFilter = { [Op.gte]: clinicMidnight(from), [Op.lt]: end };

    const [rows, lastDone] = await Promise.all([collectStockRows(dateFilter), auditLastDone()]);
    const sessions = buildSessions(rows);
    const people = buildPeople(rows, sessions);

    const userId = req.query.userId ? Number(req.query.userId) : null;
    const fnFilter = req.query.fn || null;
    const keep = (r) => (!userId || r.userId === userId) && (!fnFilter || r.fn === fnFilter);
    const events = rows.filter(keep).sort((a, b) => new Date(b.at) - new Date(a.at));

    return success(res, {
      from, to,
      lastDone,
      sessions: sessions.filter(keep),
      people,
      events: events.slice(0, MAX_AUDIT_EVENTS),
      totalEvents: events.length,
    });
  } catch (err) {
    console.error('StockReport.audit error:', err);
    return error(res, 'Failed to load the stock audit', 500);
  }
};

module.exports = { reorder, consumption, recall, disposal, walkIns, fefoOverrides, variances, inventory, expiry, audit };
