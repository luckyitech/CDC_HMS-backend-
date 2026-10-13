const { clinicToday } = require('./clinicTime');

// =====================================================================
// Stocks → Analytics → Audit (13 Oct 2026, Emu): when receiving, stocktakes
// and room balancing took place and who did them — for management to track
// the functions, set schedules and plan around leave. Pure: takes the rows
// utils/stockAudit.collectStockRows builds and groups them.
// =====================================================================

const dayOf = (at) => clinicToday(new Date(at));

/**
 * The work sessions in the rows: one per delivery received (by person +
 * document, or + day when no document), one per stocktake, one per room
 * restocked (by person + room + day), one per par change / room-doctor match.
 */
const buildSessions = (rows) => {
  const groups = new Map();
  const sessions = [];
  const add = (key, base, row, line) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...base, at: row.at, endAt: row.at, lines: 0, units: 0, items: new Set() };
      groups.set(key, g);
      sessions.push(g);
    }
    if (new Date(row.at) < new Date(g.at)) g.at = row.at;
    if (new Date(row.at) > new Date(g.endAt)) g.endAt = row.at;
    if (line) { g.lines += 1; g.units += row.quantity || 0; if (row.item) g.items.add(row.item); }
  };

  for (const r of rows) {
    const who = { userId: r.userId, staff: r.staff, role: r.role };
    if (r.type === 'stock_received') {
      const doc = r.receiptId ? `r${r.receiptId}` : `d${dayOf(r.at)}`;
      add(`recv:${r.userId}:${doc}`, { fn: 'receiving', kind: 'Delivery received', ...who, location: r.location, receipt: r.receipt }, r, true);
    } else if (r.type === 'stock_restocked') {
      add(`restock:${r.userId}:${r.locationId}:${dayOf(r.at)}`, { fn: 'rooms', kind: 'Room restocked', ...who, location: r.location }, r, true);
    } else if (r.type === 'stock_stocktake') {
      sessions.push({ fn: 'stocktake', kind: 'Stocktake', ...who, location: r.location, at: r.startedAt || r.at, endAt: r.at, summary: r.note ?? r.detail });
    } else if (r.type === 'stock_pars_changed' || r.type === 'stock_room_doctor') {
      sessions.push({ fn: 'rooms', kind: r.label, ...who, location: r.location, at: r.at, endAt: r.at, summary: r.note ?? r.detail });
    }
  }

  return sessions.map((s) => {
    if (s.summary !== undefined) return s;
    const items = [...s.items];
    const summary = [
      s.receipt ? s.receipt : null,
      `${s.lines} line${s.lines === 1 ? '' : 's'}`,
      `${s.units} unit${s.units === 1 ? '' : 's'}`,
      items.length ? items.slice(0, 4).join(', ') + (items.length > 4 ? ` +${items.length - 4}` : '') : null,
    ].filter(Boolean).join(' · ');
    const { items: _drop, ...rest } = s;
    return { ...rest, summary };
  }).sort((a, b) => new Date(b.at) - new Date(a.at));
};

/** Per person: how often they did each function in the window. */
const buildPeople = (rows, sessions) => {
  const map = new Map();
  const get = (r) => {
    const k = r.userId || r.staff;
    if (!map.has(k)) {
      map.set(k, {
        userId: r.userId, staff: r.staff, role: r.role,
        receiving: 0, stocktakes: 0, restocks: 0, parChanges: 0,
        dispensed: 0, transfers: 0, returns: 0, writeOffs: 0, total: 0,
        days: new Set(), firstAt: r.at, lastAt: r.at,
      });
    }
    return map.get(k);
  };
  for (const s of sessions) {
    const p = get(s);
    if (s.fn === 'receiving') p.receiving += 1;
    else if (s.fn === 'stocktake') p.stocktakes += 1;
    else if (s.kind === 'Room restocked') p.restocks += 1;
    else p.parChanges += 1;
  }
  for (const r of rows) {
    const p = get(r);
    p.total += 1;
    p.days.add(dayOf(r.at));
    if (new Date(r.at) < new Date(p.firstAt)) p.firstAt = r.at;
    if (new Date(r.at) > new Date(p.lastAt)) p.lastAt = r.at;
    if (r.type === 'stock_dispensed' || r.type === 'stock_used') p.dispensed += 1;
    else if (r.type === 'stock_transferred') p.transfers += 1;
    else if (r.type === 'stock_returned' || r.type === 'stock_supplier_return') p.returns += 1;
    else if (r.type === 'stock_written_off') p.writeOffs += 1;
  }
  return [...map.values()]
    .map(({ days, ...p }) => ({ ...p, activeDays: days.size }))
    .sort((a, b) => b.total - a.total);
};

module.exports = { buildSessions, buildPeople, dayOf };
