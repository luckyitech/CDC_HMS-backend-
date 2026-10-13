// Expiry report maths — pure, so it is unit-tested without a database
// (tests/expiryReport.test.js). Emu, 13 Oct 2026: "how many items expire a
// month / time range, and which items?"
//
// For every batch whose expiry date falls in the range, what became of it:
//   received   — qtyReceived at intake
//   held       — still on a shelf now (sum of its StockLevels)
//   writtenOff — expiry + damage write-offs against the batch
//   returned   — sent back to the supplier (13 Oct 2026)
//   used       — the rest: dispensed, used in clinic, or corrected at a count.
//                Derived (received − held − written off − returned), floored at 0.
// A reversed write-off is not netted out here; reversals are rare and the
// disposal register shows them.
//
// status:
//   on_shelf          held, not yet expired
//   expired_on_shelf  held, past expiry — needs writing off
//   written_off       none held, some written off as expired
//   returned          none held, some sent back to the supplier (none written off)
//   used_up           none held, nothing written off as expired

const STATUS_LABELS = {
  on_shelf: 'On shelf',
  expired_on_shelf: 'Expired — on shelf',
  written_off: 'Written off',
  returned: 'Returned to supplier',
  used_up: 'Used up',
};

const summariseExpiry = ({ batches, levels = [], writeoffs = [], today }) => {
  const heldBy = new Map();   // batchId → { total, locations: [{ name, quantity }] }
  levels.forEach((l) => {
    const e = heldBy.get(l.stockBatchId) || { total: 0, locations: [] };
    e.total += Number(l.quantity) || 0;
    e.locations.push({ name: l.locationName || '—', quantity: Number(l.quantity) || 0 });
    heldBy.set(l.stockBatchId, e);
  });
  const woBy = new Map();     // batchId → { expiry, damage }
  writeoffs.forEach((w) => {
    const e = woBy.get(w.stockBatchId) || { expiry: 0, damage: 0, returned: 0 };
    if (w.type === 'expiry_writeoff') e.expiry += Number(w.qty) || 0;
    else if (w.type === 'damage_writeoff') e.damage += Number(w.qty) || 0;
    else if (w.type === 'supplier_return') e.returned += Number(w.qty) || 0;
    woBy.set(w.stockBatchId, e);
  });

  const rows = batches.map((b) => {
    const held = heldBy.get(b.id)?.total || 0;
    const wo = woBy.get(b.id) || { expiry: 0, damage: 0, returned: 0 };
    const writtenOff = wo.expiry + wo.damage;
    const received = Number(b.qtyReceived) || 0;
    const expired = b.expiryDate < today;
    const status = held > 0
      ? (expired ? 'expired_on_shelf' : 'on_shelf')
      : (wo.expiry > 0 ? 'written_off' : (wo.returned > 0 ? 'returned' : 'used_up'));
    return {
      id: b.id,
      labelCode: b.labelCode,
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      item: b.item ? { id: b.item.id, name: b.item.name, unit: b.item.unit, category: b.item.category } : null,
      received,
      held,
      writtenOff,
      writtenOffExpired: wo.expiry,
      returned: wo.returned,
      used: Math.max(0, received - held - writtenOff - wo.returned),
      expired,
      status,
      statusLabel: STATUS_LABELS[status],
      locations: heldBy.get(b.id)?.locations || [],
    };
  });

  // One summary line per expiry month, in date order.
  const byMonth = new Map();
  rows.forEach((r) => {
    const key = String(r.expiryDate).slice(0, 7);
    const m = byMonth.get(key) || {
      month: key, batches: 0, received: 0, held: 0, used: 0, writtenOff: 0, returned: 0, expiredOnShelf: 0,
    };
    m.batches += 1;
    m.received += r.received;
    m.held += r.held;
    m.used += r.used;
    m.writtenOff += r.writtenOff;
    m.returned += r.returned;
    if (r.status === 'expired_on_shelf') m.expiredOnShelf += r.held;
    byMonth.set(key, m);
  });
  const months = [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, past: m.month < today.slice(0, 7) }));   // the whole month is behind us

  return { months, batches: rows };
};

module.exports = { summariseExpiry, STATUS_LABELS };
