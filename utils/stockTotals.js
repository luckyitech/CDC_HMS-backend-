const db = require('../models');
const { Op } = require('sequelize');

const { StockItem, StockBatch, StockLevel } = db;

// =====================================================================
// Derived stock quantities — the ONE place levels are rolled up.
//
// StockLevel is per (batch, location). Almost every screen wants it summed:
// per item, per item-and-room, or filtered against a reorder threshold. That
// roll-up used to be written out separately in the dashboard, the reorder
// report and the room-balance grid, and the copies drifted — the dashboard's
// silently dropped stocked-out items (it iterated levels, and an item at zero
// has no level rows). Everything derived from levels now comes from here.
//
// New consumers: add a function here rather than another forEach over levels.
// =====================================================================

// Load level rows once, with only the columns the roll-ups need.
// locationIds narrows the read; null means every location.
const loadLevels = (locationIds = null) => StockLevel.findAll({
  where: {
    quantity: { [Op.gt]: 0 },
    ...(locationIds ? { locationId: { [Op.in]: locationIds } } : {}),
  },
  include: [{ model: StockBatch, as: 'batch', attributes: ['id', 'stockItemId'] }],
});

// itemId → units held across every location.
const itemTotals = async () => {
  const levels = await loadLevels();
  const totals = {};
  levels.forEach((l) => {
    const id = l.batch?.stockItemId;
    if (id) totals[id] = (totals[id] || 0) + l.quantity;
  });
  return totals;
};

// `${itemId}:${locationId}` → units held. Drives the room-balance grid and the
// restock plan, which both ask "how much of this item is in this room".
const itemLocationTotals = async (locationIds = null) => {
  const levels = await loadLevels(locationIds);
  const totals = {};
  levels.forEach((l) => {
    const id = l.batch?.stockItemId;
    if (!id) return;
    const key = `${id}:${l.locationId}`;
    totals[key] = (totals[key] || 0) + l.quantity;
  });
  return totals;
};

// Active items at or below their reorder level, each with totalQuantity.
//
// Enumerating ITEMS first and defaulting the total to zero is the point: an
// item that has run out everywhere has no level rows, so a levels-first pass
// drops exactly the item that most needs reordering.
//
// reorderLevel 0 is excluded — it means "no threshold set", not "reorder when
// empty".
const itemsBelowReorder = async () => {
  const [items, totals] = await Promise.all([
    StockItem.findAll({
      where: { status: 'active', reorderLevel: { [Op.gt]: 0 } },
      attributes: ['id', 'name', 'unit', 'category', 'reorderLevel', 'reorderQuantity'],
      order: [['name', 'ASC']],
    }),
    itemTotals(),
  ]);

  return items
    .map((i) => ({ ...i.toJSON(), totalQuantity: totals[i.id] || 0 }))
    .filter((i) => i.totalQuantity <= i.reorderLevel);
};

module.exports = { itemTotals, itemLocationTotals, itemsBelowReorder };
