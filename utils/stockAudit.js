const db = require('../models');

const {
  StockActivity, StockMovement, StockReceipt, StockReceiptDocument, StockBatchEdit,
  StockItem, StockBatch, StockLocation, Supplier, User, Patient,
} = db;

// =====================================================================
// Stock audit (13 Oct 2026, Emu): "each and every function in the stock tabs,
// just like the rest of the HMS, needs to be time stamped and surface in the
// activity tabs". One derivation feeds the HMS Activity Log, the Staff File
// Activity tab and Stocks → Analytics → Audit:
//
//   • StockMovements      — every receive, dispense, use, transfer / room
//                           restock, return, return to supplier, stocktake
//                           adjustment, write-off, test stock put back
//   • StockReceipts       — a delivery document recorded
//   • StockReceiptDocuments — a scan attached / removed
//   • StockBatchEdits     — a received line corrected
//   • StockActivities     — everything else (logStockActivity below)
// =====================================================================

// Room Balance → restock picklist transfers carry this reason prefix.
const RESTOCK_REASON = 'Room restock';

/** Things with no other trace. `fn` is the Stocks function it belongs to. */
const ACTIVITY_TYPES = {
  stocktake:         { type: 'stock_stocktake',        label: 'Completed Stocktake',          fn: 'stocktake' },
  pars_changed:      { type: 'stock_pars_changed',     label: 'Changed Par Levels',           fn: 'rooms' },
  pars_copied:       { type: 'stock_pars_changed',     label: 'Copied Par Levels',            fn: 'rooms' },
  room_doctor:       { type: 'stock_room_doctor',      label: 'Matched Room to Doctor',       fn: 'rooms' },
  catalog_added:     { type: 'stock_catalog_added',    label: 'Added to Stock Catalogue',     fn: 'items' },
  catalog_edited:    { type: 'stock_catalog_edited',   label: 'Edited Stock Catalogue',       fn: 'items' },
  catalog_retired:   { type: 'stock_catalog_retired',  label: 'Retired from Stock Catalogue', fn: 'items' },
  catalog_reactivated: { type: 'stock_catalog_edited', label: 'Reactivated in Stock Catalogue', fn: 'items' },
  test_taken:        { type: 'stock_test_taken',       label: 'Took Test Stock (Later)',      fn: 'tests' },
  test_settled:      { type: 'stock_test_settled',     label: 'Settled Test Stock',           fn: 'tests' },
  levels_rebuilt:    { type: 'stock_levels_rebuilt',   label: 'Rebuilt Stock Levels',         fn: 'other' },
  invoice_read:      { type: 'stock_invoice_read',     label: 'Read Invoice',                 fn: 'receiving' },
};

const MOVEMENT_TYPES = {
  intake:          { type: 'stock_received',        label: 'Received Stock',               fn: 'receiving' },
  dispense:        { type: 'stock_dispensed',       label: 'Dispensed Stock',              fn: 'dispense' },
  use:             { type: 'stock_used',            label: 'Used Stock on Patient',        fn: 'dispense' },
  transfer:        { type: 'stock_transferred',     label: 'Transferred Stock',            fn: 'transfer' },
  restock:         { type: 'stock_restocked',       label: 'Restocked Room',               fn: 'rooms' },
  return:          { type: 'stock_returned',        label: 'Took Back Stock from Patient', fn: 'returns' },
  supplier_return: { type: 'stock_supplier_return', label: 'Returned Stock to Supplier',   fn: 'returns' },
  stocktake_adj:   { type: 'stock_count_adjusted',  label: 'Stocktake Adjustment',         fn: 'stocktake' },
  adjustment:      { type: 'stock_adjusted',        label: 'Adjusted Stock',               fn: 'stocktake' },
  expiry_writeoff: { type: 'stock_written_off',     label: 'Wrote Off Expired Stock',      fn: 'writeoff' },
  damage_writeoff: { type: 'stock_written_off',     label: 'Wrote Off Damaged Stock',      fn: 'writeoff' },
  use_cancelled:   { type: 'stock_use_cancelled',   label: 'Put Back Test Stock',          fn: 'tests' },
  reversal:        { type: 'stock_reversed',        label: 'Reversed Stock Movement',      fn: 'other' },
  // receipt_correction: shown once, as the line edit below.
};

const OTHER_TYPES = {
  delivery:        { type: 'stock_delivery_recorded', label: 'Recorded Delivery Document', fn: 'receiving' },
  scan_added:      { type: 'stock_delivery_scan',     label: 'Attached Delivery Scan',     fn: 'receiving' },
  scan_removed:    { type: 'stock_delivery_scan_removed', label: 'Removed Delivery Scan',  fn: 'receiving' },
  line_corrected:  { type: 'stock_delivery_corrected', label: 'Corrected Delivery Line',   fn: 'receiving' },
};

/** Every stock event type — the Activity Log's "Stocks — all" filter. */
const STOCK_EVENT_TYPES = [...new Set([
  ...Object.values(ACTIVITY_TYPES), ...Object.values(MOVEMENT_TYPES), ...Object.values(OTHER_TYPES),
].map((t) => t.type))];

/**
 * Record one Stocks function. Inside `transaction` it commits or rolls back
 * with the work it records; outside one it is best-effort (never throws).
 */
const logStockActivity = async ({ action, userId, locationId = null, stockItemId = null, detail = null, startedAt = null }, transaction = null) => {
  const row = { action, userId: userId || null, locationId, stockItemId, detail: detail ? String(detail).slice(0, 500) : null, startedAt };
  if (transaction) return StockActivity.create(row, { transaction });
  try { return await StockActivity.create(row); } catch (err) {
    console.error('StockActivity.log error:', err);
    return null;
  }
};

const unitWord = (n, unit) => {
  const u = unit || 'unit';
  if (Number(n) === 1) return u;
  return /(s|x|ch|sh)$/.test(u) ? `${u}es` : `${u}s`;
};
const nameOf = (u) => (u ? `${u.firstName} ${u.lastName}` : 'Unknown');
const staffName = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : 'Unknown');
const USER = ['id', 'firstName', 'lastName', 'role'];

// "from invoice" / "from invoice · batch no., expiry corrected" / "entered manually"
const CORRECTION_WORDS = { item: 'item', batchNo: 'batch no.', expiryDate: 'expiry', quantity: 'quantity' };
const receiveMethodText = (batch) => {
  if (batch?.receiveMethod !== 'invoice') return 'entered manually';
  const fixed = String(batch.sourceCorrections || '').split(',').filter(Boolean).map((f) => CORRECTION_WORDS[f] || f);
  return fixed.length ? `from invoice · ${fixed.join(', ')} corrected` : 'from invoice';
};

const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/**
 * Every stock event in the window, oldest-agnostic. Each row:
 * { type, label, fn, at, userId, staff, role, locationId, location, item,
 *   quantity, detail, patient, uhid, receiptId, receipt }
 */
const collectStockRows = async (dateFilter) => {
  const [movements, receipts, docs, edits, activities] = await Promise.all([
    StockMovement.findAll({
      where: { createdAt: dateFilter },
      include: [
        { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit'] },
        { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'stockReceiptId', 'receiveMethod', 'sourceCorrections'],
          include: [
            { model: Supplier, as: 'supplier', attributes: ['name'] },
            { model: StockReceipt, as: 'receipt', attributes: ['id', 'number'] },
          ] },
        { model: StockLocation, as: 'fromLocation', attributes: ['id', 'name'] },
        { model: StockLocation, as: 'toLocation', attributes: ['id', 'name'] },
        { model: User, as: 'performedByUser', attributes: USER },
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'], required: false },
      ],
    }),
    StockReceipt.findAll({
      where: { createdAt: dateFilter },
      include: [
        { model: Supplier, as: 'supplier', attributes: ['name'] },
        { model: User, as: 'createdByUser', attributes: USER },
      ],
    }),
    StockReceiptDocument.findAll({
      where: { createdAt: dateFilter },
      include: [
        { model: StockReceipt, as: 'receipt', attributes: ['id', 'number'] },
        { model: User, as: 'uploadedByUser', attributes: USER },
        { model: User, as: 'removedByUser', attributes: USER },
      ],
    }),
    StockBatchEdit.findAll({
      where: { createdAt: dateFilter },
      include: [
        { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'stockReceiptId'],
          include: [
            { model: StockItem, as: 'item', attributes: ['name'] },
            { model: StockReceipt, as: 'receipt', attributes: ['id', 'number'] },
          ] },
        { model: User, as: 'editedByUser', attributes: USER },
      ],
    }),
    StockActivity.findAll({
      where: { createdAt: dateFilter },
      include: [
        { model: User, as: 'user', attributes: USER },
        { model: StockLocation, as: 'location', attributes: ['id', 'name'] },
        { model: StockItem, as: 'item', attributes: ['id', 'name'] },
      ],
    }),
  ]);

  const rows = [];
  const push = (t, r) => rows.push({ type: t.type, label: t.label, fn: t.fn, ...r });

  for (const m of movements) {
    let key = m.type;
    if (key === 'receipt_correction') continue;
    if (key === 'transfer' && String(m.reason || '').startsWith(RESTOCK_REASON)) key = 'restock';
    if (key === 'adjustment' && String(m.reason || '').startsWith('Stocktake')) key = 'stocktake_adj';
    const t = MOVEMENT_TYPES[key];
    if (!t) continue;
    const u = m.performedByUser;
    const qty = `${m.quantity} ${unitWord(m.quantity, m.item?.unit)}`;
    const from = m.fromLocation?.name;
    let to = m.toLocation?.name;
    if (key === 'supplier_return') to = m.batch?.supplier?.name || 'supplier';
    if (!to && m.recipientName) to = `walk-in ${m.recipientName}`;
    const where = from && to ? `${from} → ${to}` : (from ? `from ${from}` : (to ? `to ${to}` : null));
    const receipt = m.type === 'intake' ? m.batch?.receipt : null;
    push(t, {
      at: m.createdAt, userId: u?.id || null, staff: staffName(u), role: u?.role || null,
      locationId: m.toLocationId || m.fromLocationId || null,
      location: m.type === 'intake' || key === 'restock' || m.type === 'return' ? m.toLocation?.name : (m.fromLocation?.name || m.toLocation?.name || null),
      item: m.item?.name || null, quantity: m.quantity,
      detail: [
        `${qty} ${m.item?.name || ''}`.trim(),
        where,
        m.batch?.batchNo ? `batch ${m.batch.batchNo}` : null,
        receipt ? `${receipt.number}${m.batch?.supplier?.name ? ` (${m.batch.supplier.name})` : ''}` : null,
        m.type === 'intake' ? receiveMethodText(m.batch) : null,
        m.reason && key !== 'restock' ? m.reason : null,
      ].filter(Boolean).join(' · '),
      method: m.type === 'intake' ? (m.batch?.receiveMethod || 'manual') : null,
      patient: m.Patient ? `${m.Patient.firstName} ${m.Patient.lastName}` : null,
      uhid: m.Patient?.uhid || null,
      receiptId: m.type === 'intake' ? (m.batch?.stockReceiptId || null) : null,
      receipt: m.type === 'intake' ? (m.batch?.receipt?.number || null) : null,
    });
  }

  for (const r of receipts) {
    const u = r.createdByUser;
    push(OTHER_TYPES.delivery, {
      at: r.createdAt, userId: u?.id || null, staff: staffName(u), role: u?.role || null,
      locationId: null, location: null, item: null, quantity: null,
      detail: [`${String(r.kind || 'document').replace('_', ' ')} ${r.number}`, r.supplier?.name].filter(Boolean).join(' · '),
      patient: null, uhid: null, receiptId: r.id, receipt: r.number,
    });
  }

  for (const d of docs) {
    const u = d.uploadedByUser;
    push(OTHER_TYPES.scan_added, {
      at: d.createdAt, userId: u?.id || null, staff: staffName(u), role: u?.role || null,
      locationId: null, location: null, item: null, quantity: null,
      detail: [d.receipt?.number, d.fileName].filter(Boolean).join(' · '),
      patient: null, uhid: null, receiptId: d.receipt?.id || null, receipt: d.receipt?.number || null,
    });
    if (d.removedAt && d.removedByUser) {
      const ru = d.removedByUser;
      push(OTHER_TYPES.scan_removed, {
        at: d.removedAt, userId: ru.id, staff: staffName(ru), role: ru.role || null,
        locationId: null, location: null, item: null, quantity: null,
        detail: [d.receipt?.number, d.fileName].filter(Boolean).join(' · '),
        patient: null, uhid: null, receiptId: d.receipt?.id || null, receipt: d.receipt?.number || null,
      });
    }
  }

  for (const e of edits) {
    const u = e.editedByUser;
    const changes = parseJson(e.changes) || [];
    const what = (Array.isArray(changes) ? changes : [])
      .map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(', ');
    push(OTHER_TYPES.line_corrected, {
      at: e.createdAt, userId: u?.id || null, staff: staffName(u), role: u?.role || null,
      locationId: null, location: null, item: e.batch?.item?.name || null, quantity: null,
      detail: [e.batch?.item?.name, e.batch?.receipt?.number, what, e.reason ? `why: ${e.reason}` : null].filter(Boolean).join(' · '),
      patient: null, uhid: null, receiptId: e.batch?.stockReceiptId || null, receipt: e.batch?.receipt?.number || null,
    });
  }

  for (const a of activities) {
    const t = ACTIVITY_TYPES[a.action];
    if (!t) continue;
    const u = a.user;
    push({ ...t }, {
      at: a.createdAt, userId: u?.id || null, staff: staffName(u), role: u?.role || null,
      locationId: a.locationId || null, location: a.location?.name || null, item: a.item?.name || null, quantity: null,
      detail: [a.location?.name, a.detail].filter(Boolean).join(' · '),
      note: a.detail || null,   // without the location — the Audit has a Where column
      startedAt: a.startedAt || null,
      patient: null, uhid: null, receiptId: null, receipt: null,
    });
  }

  return rows;
};

module.exports = {
  RESTOCK_REASON, ACTIVITY_TYPES, MOVEMENT_TYPES, OTHER_TYPES, STOCK_EVENT_TYPES,
  logStockActivity, collectStockRows, unitWord, nameOf, receiveMethodText,
};
