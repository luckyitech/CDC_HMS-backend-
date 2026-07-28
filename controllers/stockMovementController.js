const { success, error } = require('../utils/response');
const db = require('../models');
const { Op } = require('sequelize');
const {
  applyMovement,
  reverseMovement,
  suggestFefoBatch,
  rebuildLevels,
  LedgerError,
} = require('../utils/stockLedger');

const {
  sequelize, StockItem, StockBatch, StockMovement, StockLevel, StockLocation,
  Supplier, User, Patient,
} = db;
const { runExpirySweepIfDue } = require('../utils/stockExpirySweep');
const { resolvePatient } = require('../utils/patientFamily');

// Every action here writes through utils/stockLedger inside one transaction —
// the append-only ledger and the materialized levels can never disagree.

// Translate ledger validation failures into clean 400s; anything else is a 500.
const handleErr = (label) => (res, err) => {
  if (err instanceof LedgerError) return error(res, err.message, err.statusCode);
  console.error(`Stock.${label} error:`, err);
  return error(res, `Failed to ${label.replace(/([A-Z])/g, ' $1').toLowerCase()}`, 500);
};

const MOVEMENT_INCLUDE = [
  { model: StockItem,     as: 'item',           attributes: ['id', 'name', 'unit', 'category', 'isHighAlert'] },
  { model: StockBatch,    as: 'batch',          attributes: ['id', 'batchNo', 'labelCode', 'expiryDate'] },
  { model: StockLocation, as: 'fromLocation',   attributes: ['id', 'name'] },
  { model: StockLocation, as: 'toLocation',     attributes: ['id', 'name'] },
  { model: User,          as: 'performedByUser', attributes: ['id', 'firstName', 'lastName'] },
  // Patient a dispense went to (null on over-the-counter / non-patient rows).
  // Unaliased belongsTo → the row comes back as movement.Patient.
  { model: Patient,       attributes: ['id', 'uhid', 'firstName', 'lastName'], required: false },
];

// Resolve an OPTIONAL patient UHID to a merge-aware canonical id, for
// attaching a dispense/use to the patient who received it. Returns
// { PatientId: null } when no uhid is given (over-the-counter). Throws a
// LedgerError (clean status) for an unknown or merged-away record.
const resolveOptionalPatient = async (uhid) => {
  if (!uhid) return { PatientId: null };
  const family = await resolvePatient(uhid);
  if (!family) throw new LedgerError('Patient not found', 404);
  if (family.isDeactivated) {
    throw new LedgerError('This patient record was merged into another. Use the current record.', 403);
  }
  return { PatientId: family.patient.id };
};

// FEFO override reason for advisory paths (use / checkout): returns a logged
// reason when the chosen batch isn't the earliest-expiring at the location, so
// it still surfaces in the FEFO-overrides report. Null when compliant.
const fefoOverrideReasonFor = async (batch, locationId, label) => {
  const suggestion = await suggestFefoBatch(batch.stockItemId, locationId);
  if (suggestion && suggestion.batch.id !== batch.id) {
    return `FEFO override (${label}): earlier batch ${suggestion.batch.labelCode || suggestion.batch.id}` +
      (suggestion.batch.expiryDate ? ` exp ${suggestion.batch.expiryDate}` : '');
  }
  return null;
};

// Resolve a batch by id or by its printed label code (scan-first UX).
const findBatch = async (stockBatchId, labelCode, t = null) => {
  if (stockBatchId) return StockBatch.findByPk(stockBatchId, { transaction: t });
  if (labelCode) {
    return StockBatch.findOne({
      where: { labelCode: String(labelCode).trim().toUpperCase() },
      transaction: t,
    });
  }
  return null;
};

// FEFO gate shared by dispense and transfer-out: if the chosen batch is not
// the suggested one, the caller must supply fefoOverrideReason. Returns null
// to proceed, or a response-ready payload describing the suggestion.
const fefoCheck = async (batch, locationId, fefoOverrideReason) => {
  const suggestion = await suggestFefoBatch(batch.stockItemId, locationId);
  if (!suggestion || suggestion.batch.id === batch.id) return null;   // FEFO-compliant
  if (String(fefoOverrideReason || '').trim()) {
    return { overrideReason: String(fefoOverrideReason).trim(), suggestion };
  }
  return {
    blocked: true,
    suggestion: {
      stockBatchId: suggestion.batch.id,
      labelCode: suggestion.batch.labelCode,
      batchNo: suggestion.batch.batchNo,
      expiryDate: suggestion.batch.expiryDate,
      available: suggestion.available,
    },
  };
};

// ------------------------------------
// POST /api/stock/intake
// One transaction: create the batch, assign its STK- label code from the row
// id, and post the intake movement. Body: stockItemId, quantity, locationId,
// batchNo?, expiryDate?, supplierId?, receivedAt?
// ------------------------------------
const intake = async (req, res) => {
  try {
    const { stockItemId, quantity, locationId, batchNo, expiryDate, supplierId, receivedAt } = req.body;

    const item = await StockItem.findByPk(stockItemId);
    if (!item || item.status !== 'active') return error(res, 'Stock item not found or retired', 404);

    const location = await StockLocation.findByPk(locationId);
    if (!location || location.status !== 'active') return error(res, 'Receiving location not found or retired', 404);

    // Medications must carry an expiry; other categories may be undated.
    if (item.category === 'medication' && !expiryDate) {
      return error(res, 'Expiry date is required for medications');
    }
    if (supplierId) {
      const supplier = await Supplier.findByPk(supplierId);
      if (!supplier || supplier.status !== 'active') return error(res, 'Supplier not found or retired', 404);
    }

    const result = await sequelize.transaction(async (t) => {
      const batch = await StockBatch.create({
        stockItemId: item.id,
        batchNo: batchNo ? String(batchNo).trim() : null,
        expiryDate: expiryDate || null,
        supplierId: supplierId || null,
        qtyReceived: parseInt(quantity, 10),
        receivedAt: receivedAt || new Date(),
        receivedById: req.user.id,          // from the JWT, never the client
      }, { transaction: t });

      // Internal shelf-label barcode — the STK- namespace reserved in
      // barcodeController. Assigned from the id so it is unique by construction.
      await batch.update(
        { labelCode: `STK-${String(batch.id).padStart(6, '0')}` },
        { transaction: t }
      );

      const movement = await applyMovement({
        type: 'intake',
        stockBatchId: batch.id,
        quantity,
        toLocationId: location.id,
        performedById: req.user.id,
      }, t);

      return { batch, movement };
    });

    return success(res, {
      batch: result.batch,
      movement: result.movement,
      item: { id: item.id, name: item.name, unit: item.unit },
    }, 201);
  } catch (err) {
    return handleErr('intake')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/dispense — stock leaves the world with the patient.
// Body: stockBatchId | labelCode, locationId, quantity, fefoOverrideReason?,
//       uhid? (optional — attaches the patient who collected it; over-the-
//       counter collection omits it).
// FEFO: if an earlier-expiring batch of the same item sits at this location,
// respond 409 with the suggestion; the user may resubmit with a reason
// (logged override — the report reads these).
// ------------------------------------
const dispense = async (req, res) => {
  try {
    const { locationId, quantity, fefoOverrideReason, uhid } = req.body;

    const batch = await findBatch(req.body.stockBatchId, req.body.labelCode);
    if (!batch) return error(res, 'Batch not found', 404);

    const location = await StockLocation.findByPk(locationId);
    if (!location || location.status !== 'active') return error(res, 'Location not found or retired', 404);
    if (!location.isDispensing) return error(res, `${location.name} is not a dispensing location`);

    // Patient is required on this endpoint — a dispense is a named handover, so
    // it always traces to a patient (bad-batch recall depends on it).
    if (!uhid) return error(res, 'A patient is required to dispense — attach the patient');
    const { PatientId } = await resolveOptionalPatient(uhid);

    const fefo = await fefoCheck(batch, location.id, fefoOverrideReason);
    if (fefo?.blocked) {
      return res.status(409).json({
        success: false,
        message: 'An earlier-expiring batch of this item is at this location',
        fefoSuggestion: fefo.suggestion,
      });
    }

    const movement = await sequelize.transaction((t) => applyMovement({
      type: 'dispense',
      stockBatchId: batch.id,
      quantity,
      fromLocationId: location.id,
      performedById: req.user.id,
      PatientId,
      reason: fefo ? `FEFO override: ${fefo.overrideReason}` : null,
    }, t));

    return success(res, movement, 201);
  } catch (err) {
    return handleErr('dispense')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/use — point-of-care consumption from a room (e.g. an insulin
// shot, a dressing, a branula used on the patient in the room).
// Open to all clinical roles (authorize gate at the route, NOT authorizeStock)
// — gating it would guarantee unrecorded usage and rotten room counts.
// Body: stockBatchId | labelCode, locationId, quantity, uhid? (optional patient
//       who it was used on — defaults to the in-consultation patient in the UI).
// FEFO is advisory here (the clinician holds the physical box): a non-earliest
// batch is logged as an override so it still shows in the FEFO report.
// ------------------------------------
const use = async (req, res) => {
  try {
    const { locationId, quantity, uhid } = req.body;

    const batch = await findBatch(req.body.stockBatchId, req.body.labelCode);
    if (!batch) return error(res, 'Batch not found', 404);

    const { PatientId } = await resolveOptionalPatient(uhid);
    const reason = await fefoOverrideReasonFor(batch, locationId, 'use');

    const movement = await sequelize.transaction((t) => applyMovement({
      type: 'use',
      stockBatchId: batch.id,
      quantity,
      fromLocationId: locationId,
      performedById: req.user.id,
      PatientId,
      reason,
    }, t));

    return success(res, movement, 201);
  } catch (err) {
    return handleErr('use')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/transfer — between locations (store → room restock, etc).
// Same FEFO gate as dispense on the way out of the source location.
// Body: stockBatchId | labelCode, fromLocationId, toLocationId, quantity,
//       fefoOverrideReason?
// ------------------------------------
const transfer = async (req, res) => {
  try {
    const { fromLocationId, toLocationId, quantity, fefoOverrideReason } = req.body;
    if (fromLocationId && fromLocationId === toLocationId) {
      return error(res, 'Source and destination are the same location');
    }

    const batch = await findBatch(req.body.stockBatchId, req.body.labelCode);
    if (!batch) return error(res, 'Batch not found', 404);

    const fefo = await fefoCheck(batch, fromLocationId, fefoOverrideReason);
    if (fefo?.blocked) {
      return res.status(409).json({
        success: false,
        message: 'An earlier-expiring batch of this item is at this location',
        fefoSuggestion: fefo.suggestion,
      });
    }

    const movement = await sequelize.transaction((t) => applyMovement({
      type: 'transfer',
      stockBatchId: batch.id,
      quantity,
      fromLocationId,
      toLocationId,
      performedById: req.user.id,
      reason: fefo ? `FEFO override: ${fefo.overrideReason}` : null,
    }, t));

    return success(res, movement, 201);
  } catch (err) {
    return handleErr('transfer')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/adjustment — count corrections (reason always required).
// Body: stockBatchId, locationId, direction ('increase'|'decrease'),
//       quantity, reason
// ------------------------------------
const adjustment = async (req, res) => {
  try {
    const { stockBatchId, locationId, direction, quantity, reason } = req.body;
    if (!['increase', 'decrease'].includes(direction)) {
      return error(res, "direction must be 'increase' or 'decrease'");
    }

    const movement = await sequelize.transaction((t) => applyMovement({
      type: 'adjustment',
      stockBatchId,
      quantity,
      fromLocationId: direction === 'decrease' ? locationId : null,
      toLocationId: direction === 'increase' ? locationId : null,
      performedById: req.user.id,
      reason,
    }, t));

    return success(res, movement, 201);
  } catch (err) {
    return handleErr('adjustment')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/writeoff — expired or damaged stock leaves the world.
// Body: stockBatchId | labelCode, locationId, quantity,
//       kind ('expiry'|'damage'), reason
// ------------------------------------
const writeoff = async (req, res) => {
  try {
    const { locationId, quantity, kind, reason } = req.body;
    if (!['expiry', 'damage'].includes(kind)) {
      return error(res, "kind must be 'expiry' or 'damage'");
    }

    const batch = await findBatch(req.body.stockBatchId, req.body.labelCode);
    if (!batch) return error(res, 'Batch not found', 404);

    const movement = await sequelize.transaction((t) => applyMovement({
      type: `${kind}_writeoff`,
      stockBatchId: batch.id,
      quantity,
      fromLocationId: locationId,
      performedById: req.user.id,
      reason,
    }, t));

    return success(res, movement, 201);
  } catch (err) {
    return handleErr('writeoff')(res, err);
  }
};

// ------------------------------------
// POST /api/stock/movements/:id/reverse — the only correction mechanism.
// Ledger rows are immutable; this posts a mirrored 'reversal' row.
// ------------------------------------
const reverse = async (req, res) => {
  try {
    const movement = await sequelize.transaction((t) =>
      reverseMovement(req.params.id, req.user.id, req.body.reason, t));
    return success(res, movement, 201);
  } catch (err) {
    return handleErr('reverse')(res, err);
  }
};

// ------------------------------------
// GET /api/stock/movements — the filterable history (straight SQL over the
// ledger). Filters: itemId, batchId, locationId (from OR to), type,
// performedById, uhid (patient), from, to (dates), page, limit.
// ------------------------------------
const listMovements = async (req, res) => {
  try {
    const { itemId, batchId, locationId, type, performedById, uhid, from, to } = req.query;
    const where = {};
    if (itemId) where.stockItemId = itemId;
    if (batchId) where.stockBatchId = batchId;
    if (type) where.type = type;
    if (performedById) where.performedById = performedById;
    if (locationId) {
      where[Op.or] = [{ fromLocationId: locationId }, { toLocationId: locationId }];
    }
    // Patient filter — merge-aware: a merged-away UHID still finds the family's
    // movements (reads across family.patientIds).
    if (uhid) {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, 'Patient not found', 404);
      where.PatientId = { [Op.in]: family.patientIds };
    }
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59`);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const { rows, count } = await StockMovement.findAndCountAll({
      where,
      include: MOVEMENT_INCLUDE,
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    return success(res, { movements: rows, total: count, page, pages: Math.ceil(count / limit) });
  } catch (err) {
    console.error('Stock.listMovements error:', err);
    return error(res, 'Failed to load movements', 500);
  }
};

// ------------------------------------
// GET /api/stock/levels?locationId=&itemId= — current quantities with batch
// and item context; zero rows omitted.
// ------------------------------------
const listLevels = async (req, res) => {
  try {
    const where = { quantity: { [Op.gt]: 0 } };
    if (req.query.locationId) where.locationId = req.query.locationId;

    const batchWhere = {};
    if (req.query.itemId) batchWhere.stockItemId = req.query.itemId;

    const levels = await StockLevel.findAll({
      where,
      include: [
        {
          model: StockBatch,
          as: 'batch',
          where: Object.keys(batchWhere).length ? batchWhere : undefined,
          include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'category', 'requiresColdChain', 'isHighAlert', 'reorderLevel'] }],
        },
        { model: StockLocation, as: 'location', attributes: ['id', 'name', 'kind'] },
      ],
      order: [['locationId', 'ASC']],
    });

    return success(res, levels);
  } catch (err) {
    console.error('Stock.listLevels error:', err);
    return error(res, 'Failed to load stock levels', 500);
  }
};

// ------------------------------------
// GET /api/stock/batches?expiringWithinDays=&itemId= — batch list with
// remaining quantity per location; drives the expiry dashboard.
// ------------------------------------
const listBatches = async (req, res) => {
  try {
    const where = {};
    if (req.query.itemId) where.stockItemId = req.query.itemId;
    if (req.query.status) where.status = req.query.status;

    if (req.query.expiringWithinDays) {
      const days = parseInt(req.query.expiringWithinDays, 10);
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + days);
      where.expiryDate = { [Op.ne]: null, [Op.lte]: horizon.toISOString().slice(0, 10) };
      where.status = 'active';
    }

    const batches = await StockBatch.findAll({
      where,
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'category'] },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
        {
          model: StockLevel, as: 'levels',
          where: { quantity: { [Op.gt]: 0 } },
          required: req.query.expiringWithinDays ? true : false,   // expiry list: only batches still held
          include: [{ model: StockLocation, as: 'location', attributes: ['id', 'name'] }],
        },
      ],
      order: [['expiryDate', 'ASC']],
    });

    return success(res, batches);
  } catch (err) {
    console.error('Stock.listBatches error:', err);
    return error(res, 'Failed to load batches', 500);
  }
};

// ------------------------------------
// GET /api/stock/dashboard — headline cards + expiry buckets in ONE request
// (the tool should not need three).
// ------------------------------------
const dashboard = async (req, res) => {
  try {
    // Daily expired-batch sweep — no job scheduler exists, so the first
    // dashboard load of the day runs it. Failure must not break the page.
    const sweep = await runExpirySweepIfDue()
      .catch((e) => { console.error('Stock.expirySweep error:', e); return { ran: false, newlyExpired: 0 }; });

    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const plusDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
    const startOfDay = new Date(today.toDateString());

    // Levels joined to batches once; totals derived in JS.
    const levels = await StockLevel.findAll({
      where: { quantity: { [Op.gt]: 0 } },
      include: [{
        model: StockBatch, as: 'batch',
        attributes: ['id', 'stockItemId', 'batchNo', 'labelCode', 'expiryDate', 'status'],
        include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'reorderLevel'] }],
      }, { model: StockLocation, as: 'location', attributes: ['id', 'name'] }],
    });

    const totalsByItem = {};
    levels.forEach((l) => {
      const item = l.batch?.item;
      if (!item) return;
      totalsByItem[item.id] = totalsByItem[item.id]
        || { id: item.id, name: item.name, unit: item.unit, reorderLevel: item.reorderLevel, total: 0 };
      totalsByItem[item.id].total += l.quantity;
    });

    const activeItemCount = await StockItem.count({ where: { status: 'active' } });
    const itemsBelowReorder = Object.values(totalsByItem)
      .filter((i) => i.reorderLevel > 0 && i.total <= i.reorderLevel);

    // Expiry buckets from the held batches (unique per batch).
    const seen = new Set();
    const buckets = { expired: [], d30: [], d60: [], d90: [] };
    levels.forEach((l) => {
      const b = l.batch;
      if (!b?.expiryDate || seen.has(b.id)) return;
      seen.add(b.id);
      const entry = {
        stockBatchId: b.id,
        labelCode: b.labelCode,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate,
        item: b.item ? { id: b.item.id, name: b.item.name, unit: b.item.unit } : null,
        locations: levels
          .filter((x) => x.batch?.id === b.id)
          .map((x) => ({ id: x.location.id, name: x.location.name, quantity: x.quantity })),
      };
      if (b.expiryDate < iso(today)) buckets.expired.push(entry);
      else if (b.expiryDate <= iso(plusDays(30))) buckets.d30.push(entry);
      else if (b.expiryDate <= iso(plusDays(60))) buckets.d60.push(entry);
      else if (b.expiryDate <= iso(plusDays(90))) buckets.d90.push(entry);
    });
    Object.values(buckets).forEach((arr) => arr.sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : 1)));

    const todaysMovements = await StockMovement.count({
      where: { createdAt: { [Op.gte]: startOfDay } },
    });

    return success(res, {
      cards: {
        activeItems: activeItemCount,
        itemsBelowReorder: itemsBelowReorder.length,
        batchesExpiring30: buckets.expired.length + buckets.d30.length,
        todaysMovements,
      },
      itemsBelowReorder,
      expiry: buckets,
      sweep,   // { ran, newlyExpired } — dashboard banner when batches expired
    });
  } catch (err) {
    console.error('Stock.dashboard error:', err);
    return error(res, 'Failed to load stock dashboard', 500);
  }
};

// ------------------------------------
// POST /api/stock/checkout-dispense — reception dispenses the supplies scanned
// on the discharge/checkout charge sheet, all in ONE transaction, attached to
// the patient. This is the patient-linked dispensing path (the standalone
// Dispense tab stays patient-free for over-the-counter collection).
//
// Merge-aware: writes family.patient.id and refuses a merged-away/inactive
// record. Skips the FEFO "earlier batch exists" nag — reception is holding the
// physical box, so the scanned batch is what goes — but applyMovement still
// hard-blocks an expired batch and refuses to take a level below zero.
//
// Open to reception/clinical roles (staff/admin/doctor), NOT authorizeStock —
// dispensing at checkout must not require the stock-management flag, same
// rationale as POST /use.
// Body: { uhid, lines: [{ stockBatchId, locationId, quantity }] }
// ------------------------------------
const checkoutDispense = async (req, res) => {
  try {
    const { uhid, lines } = req.body;
    if (!uhid) return error(res, 'Patient UHID is required');
    if (!Array.isArray(lines) || lines.length === 0) return error(res, 'No supplies to dispense');

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) {
      return error(res, 'This patient record was merged into another. Dispense from the current record.', 403);
    }

    for (const l of lines) {
      if (!l.stockBatchId || !l.locationId) return error(res, 'Each supply needs a batch and a location');
      if (!Number.isInteger(Number(l.quantity)) || Number(l.quantity) < 1) {
        return error(res, 'Each supply needs a whole quantity of at least 1');
      }
    }

    const movements = await sequelize.transaction(async (t) => {
      const out = [];
      for (const l of lines) {
        // FEFO nudge is advisory at the desk (reception holds the box), but a
        // logged override keeps it honest — if this isn't the earliest-expiring
        // batch at the location, record why in the FEFO-overrides report.
        let reason = null;
        const batch = await StockBatch.findByPk(l.stockBatchId, { transaction: t });
        if (batch) {
          const suggestion = await suggestFefoBatch(batch.stockItemId, l.locationId);
          if (suggestion && suggestion.batch.id !== batch.id) {
            reason = `FEFO override (checkout): earlier batch ${suggestion.batch.labelCode || suggestion.batch.id}` +
              (suggestion.batch.expiryDate ? ` exp ${suggestion.batch.expiryDate}` : '');
          }
        }
        out.push(await applyMovement({
          type: 'dispense',
          stockBatchId: l.stockBatchId,
          quantity: l.quantity,
          fromLocationId: l.locationId,
          performedById: req.user.id,       // from the JWT, never the client
          PatientId: family.patient.id,     // merge-aware canonical id
          reason,
        }, t));
      }
      return out;
    });

    return success(res, { dispensed: movements.length, movements }, 201);
  } catch (err) {
    if (err instanceof LedgerError) return error(res, err.message, err.statusCode);
    console.error('Stock.checkoutDispense error:', err);
    return error(res, 'Failed to dispense supplies', 500);
  }
};

// ------------------------------------
// GET /api/stock/patient-dispenses?uhid= — every stock item dispensed to a
// patient (merge-aware), newest first. Drives the "dispensed to this patient"
// panel on the patient profile. Clinical/reception roles, not authorizeStock —
// it's patient care context, and only exposes this patient's own rows.
// ------------------------------------
const patientDispenses = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'Patient UHID is required');

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const rows = await StockMovement.findAll({
      // Both stock a patient received: 'dispense' (taken home) and 'use'
      // (administered in the room, e.g. an insulin shot) — both matter for a
      // bad-batch recall.
      where: { type: { [Op.in]: ['dispense', 'use'] }, PatientId: { [Op.in]: family.patientIds } },
      include: [
        { model: StockItem,  as: 'item',  attributes: ['id', 'name', 'unit'] },
        { model: StockBatch, as: 'batch', attributes: ['id', 'labelCode', 'batchNo', 'expiryDate'] },
        { model: User, as: 'performedByUser', attributes: ['id', 'firstName', 'lastName'] },
      ],
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      limit: 200,
    });

    return success(res, rows);
  } catch (err) {
    console.error('Stock.patientDispenses error:', err);
    return error(res, 'Failed to load dispensing history', 500);
  }
};

// ------------------------------------
// GET /api/stock/fefo-suggestion?stockItemId=&locationId= — the earliest-
// expiring batch of an item at a location. Drives the checkout FEFO nudge:
// the desk compares this against the batch it just scanned. Clinical/reception
// roles (used at checkout), not authorizeStock.
// ------------------------------------
const fefoSuggestion = async (req, res) => {
  try {
    const { stockItemId, locationId } = req.query;
    if (!stockItemId || !locationId) return error(res, 'stockItemId and locationId are required');
    const suggestion = await suggestFefoBatch(Number(stockItemId), Number(locationId));
    if (!suggestion) return success(res, { suggestion: null });
    return success(res, {
      suggestion: {
        stockBatchId: suggestion.batch.id,
        labelCode:    suggestion.batch.labelCode,
        batchNo:      suggestion.batch.batchNo,
        expiryDate:   suggestion.batch.expiryDate,
        available:    suggestion.available,
      },
    });
  } catch (err) {
    console.error('Stock.fefoSuggestion error:', err);
    return error(res, 'Failed to check FEFO', 500);
  }
};

// ------------------------------------
// GET /api/stock/use-options?locationId= — the data the Record Use flow
// needs, open to ALL clinical roles (the full levels endpoint stays
// permission-gated; this returns only what point-of-care recording requires):
// active locations, and — given a location — the batches it holds,
// FEFO-ordered per item.
// ------------------------------------
const useOptions = async (req, res) => {
  try {
    const locations = await StockLocation.findAll({
      where: { status: 'active' },
      attributes: ['id', 'name', 'kind'],
      order: [['name', 'ASC']],
    });

    let batches = [];
    if (req.query.locationId) {
      const levels = await StockLevel.findAll({
        where: { locationId: req.query.locationId, quantity: { [Op.gt]: 0 } },
        include: [{
          model: StockBatch, as: 'batch',
          where: { status: 'active' },
          include: [{ model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'isHighAlert'] }],
        }],
      });
      batches = levels
        .map((l) => ({
          stockBatchId: l.batch.id,
          labelCode: l.batch.labelCode,
          batchNo: l.batch.batchNo,
          expiryDate: l.batch.expiryDate,
          available: l.quantity,
          item: l.batch.item,
        }))
        .sort((a, b) => {
          if (a.item.name !== b.item.name) return a.item.name.localeCompare(b.item.name);
          const ax = a.expiryDate || '9999-12-31';
          const bx = b.expiryDate || '9999-12-31';
          return ax < bx ? -1 : 1;
        });
    }

    return success(res, { locations, batches });
  } catch (err) {
    console.error('Stock.useOptions error:', err);
    return error(res, 'Failed to load use options', 500);
  }
};

// ------------------------------------
// POST /api/stock/levels/rebuild — admin-only escape hatch: recompute the
// materialized levels from the ledger.
// ------------------------------------
const rebuild = async (req, res) => {
  try {
    const rows = await rebuildLevels();
    return success(res, { message: `Levels rebuilt from ledger (${rows} rows)` });
  } catch (err) {
    console.error('Stock.rebuild error:', err);
    return error(res, 'Failed to rebuild levels', 500);
  }
};

module.exports = {
  intake,
  dispense,
  use,
  transfer,
  adjustment,
  writeoff,
  reverse,
  listMovements,
  listLevels,
  listBatches,
  dashboard,
  useOptions,
  fefoSuggestion,
  patientDispenses,
  checkoutDispense,
  rebuild,
};
