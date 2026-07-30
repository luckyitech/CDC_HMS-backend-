const { success, error } = require('../utils/response');
const db = require('../models');
const { Op } = require('sequelize');

const { StockItem, StockLocation, Supplier, StockBatch, StockLevel, CatalogItem, User } = db;

// =====================================================================
// Stock reference data: items, locations, suppliers.
// All three share the same shape — soft delete via status, attribution via
// addedById/lastUpdatedById from the JWT — so one factory builds the CRUD
// and each model only declares its editable fields. PUT never deletes;
// retiring is a status update.
// =====================================================================

const ATTRIBUTION_INCLUDE = [
  { model: User, as: 'addedByUser',   attributes: ['id', 'firstName', 'lastName'] },
  { model: User, as: 'updatedByUser', attributes: ['id', 'firstName', 'lastName'] },
];

const pick = (source, fields) => {
  const out = {};
  fields.forEach((f) => {
    if (source[f] !== undefined) out[f] = source[f];
  });
  return out;
};

// Units still held, for the row about to be retired. `stockHeld` is supplied
// per model because "stock belonging to this row" is a different join for a
// location than for an item.
//
// Retiring something that still holds stock used to be accepted silently, and
// the stock was then orphaned: a retired LOCATION disappears from every picker,
// so its contents can no longer be transferred, dispensed or written off, while
// still counting towards on-hand totals. A retired ITEM is worse — its units
// stay in the ledger and on the Items screen, but it drops out of the reorder
// report, so the clinic can be silently short of something it still stocks.
//
// Refusing is the only safe answer: the stock has to be moved or written off
// deliberately, and only then can the row be retired.
const stockHeldByLocation = async (locationId) =>
  (await StockLevel.sum('quantity', { where: { locationId, quantity: { [Op.gt]: 0 } } })) || 0;

const stockHeldByItem = async (stockItemId) => {
  const levels = await StockLevel.findAll({
    where: { quantity: { [Op.gt]: 0 } },
    include: [{ model: StockBatch, as: 'batch', attributes: [], where: { stockItemId }, required: true }],
    attributes: ['quantity'],
  });
  return levels.reduce((n, l) => n + l.quantity, 0);
};

// Generic list/create/update for a soft-deleted reference table.
const crudFor = (Model, { label, fields, extraInclude = [], validate = null, stockHeld = null }) => ({
  list: async (req, res) => {
    try {
      const where = {};
      // Default to active rows; ?includeRetired=true shows everything.
      if (req.query.includeRetired !== 'true') where.status = 'active';
      if (req.query.q) where.name = { [Op.like]: `%${req.query.q}%` };

      const rows = await Model.findAll({
        where,
        include: [...ATTRIBUTION_INCLUDE, ...extraInclude],
        order: [['name', 'ASC']],
      });
      return success(res, rows);
    } catch (err) {
      console.error(`Stock.${label}.list error:`, err);
      return error(res, `Failed to load ${label}s`, 500);
    }
  },

  create: async (req, res) => {
    try {
      const data = pick(req.body, fields);
      if (!String(data.name || '').trim()) return error(res, 'Name is required');
      data.name = String(data.name).trim();

      if (validate) {
        const msg = await validate(data);
        if (msg) return error(res, msg);
      }

      const existing = await Model.findOne({ where: { name: data.name } });
      if (existing) {
        if (existing.status === 'active') return error(res, `A ${label} with this name already exists`, 409);
        // Re-adding a retired entry revives it rather than duplicating.
        await existing.update({ ...data, status: 'active', lastUpdatedById: req.user.id });
        return success(res, existing);
      }

      const row = await Model.create({ ...data, status: 'active', addedById: req.user.id });
      return success(res, row, 201);
    } catch (err) {
      console.error(`Stock.${label}.create error:`, err);
      return error(res, `Failed to create ${label}`, 500);
    }
  },

  update: async (req, res) => {
    try {
      const row = await Model.findByPk(req.params.id);
      if (!row) return error(res, `${label} not found`, 404);

      const data = pick(req.body, fields);
      // Soft delete / revive travels through the same endpoint.
      if (req.body.status !== undefined) {
        if (!['active', 'retired'].includes(req.body.status)) return error(res, 'Invalid status');
        data.status = req.body.status;

        // Retiring something that still holds stock orphans that stock — see
        // the note above stockHeldByLocation.
        if (data.status === 'retired' && row.status !== 'retired' && stockHeld) {
          const held = await stockHeld(row.id);
          if (held > 0) {
            return error(
              res,
              `${row.name} still holds ${held} unit(s) of stock. ` +
              'Move them elsewhere or write them off first — retiring now would leave them ' +
              'counted but unreachable.',
              409
            );
          }
        }
      }
      if (data.name !== undefined) {
        data.name = String(data.name).trim();
        if (!data.name) return error(res, 'Name cannot be empty');
      }

      if (validate) {
        const msg = await validate({ ...row.dataValues, ...data });
        if (msg) return error(res, msg);
      }

      await row.update({ ...data, lastUpdatedById: req.user.id });
      return success(res, row);
    } catch (err) {
      console.error(`Stock.${label}.update error:`, err);
      return error(res, `Failed to update ${label}`, 500);
    }
  },
});

// ---------------------------------------------------------------------
// Items — the factory plus item-only extras: CatalogItem link validation and
// a current-total-quantity column merged into the list.
// ---------------------------------------------------------------------
const ITEM_FIELDS = [
  'name', 'category', 'catalogItemId', 'unit', 'packSize', 'gtin',
  'requiresColdChain', 'isHighAlert', 'reorderLevel', 'reorderQuantity',
];

const validateItem = async (data) => {
  if (!String(data.category || '').trim()) return 'Category is required';
  if (!String(data.unit || '').trim()) return 'Unit is required';
  if (data.packSize !== undefined && (!Number.isInteger(Number(data.packSize)) || Number(data.packSize) < 1)) {
    return 'Pack size must be a whole number of at least 1';
  }
  if (data.catalogItemId) {
    const cat = await CatalogItem.findByPk(data.catalogItemId);
    if (!cat || cat.type !== 'medication') return 'catalogItemId must reference a medication catalogue entry';
  }
  return null;
};

const itemsCrud = crudFor(StockItem, {
  label: 'item',
  fields: ITEM_FIELDS,
  extraInclude: [{ model: CatalogItem, as: 'catalogItem', attributes: ['id', 'name', 'detail', 'drugClass'] }],
  validate: validateItem,
  stockHeld: stockHeldByItem,
});

// List items with their clinic-wide total quantity (levels summed through
// batches — two indexed queries merged in JS, no raw SQL).
const listItems = async (req, res) => {
  try {
    const where = {};
    if (req.query.includeRetired !== 'true') where.status = 'active';
    if (req.query.q) where.name = { [Op.like]: `%${req.query.q}%` };
    if (req.query.category) where.category = req.query.category;
    if (req.query.gtin) where.gtin = req.query.gtin;

    const items = await StockItem.findAll({
      where,
      include: [
        ...ATTRIBUTION_INCLUDE,
        { model: CatalogItem, as: 'catalogItem', attributes: ['id', 'name', 'detail', 'drugClass'] },
      ],
      order: [['name', 'ASC']],
    });

    const levels = await StockLevel.findAll({
      where: { quantity: { [Op.gt]: 0 } },
      include: [{ model: StockBatch, as: 'batch', attributes: ['id', 'stockItemId'] }],
    });
    const totals = {};
    levels.forEach((l) => {
      const itemId = l.batch?.stockItemId;
      if (itemId) totals[itemId] = (totals[itemId] || 0) + l.quantity;
    });

    return success(res, items.map((i) => ({
      ...i.toJSON(),
      totalQuantity: totals[i.id] || 0,
    })));
  } catch (err) {
    console.error('Stock.item.list error:', err);
    return error(res, 'Failed to load items', 500);
  }
};

// ---------------------------------------------------------------------
// Locations & suppliers — pure factory output.
// ---------------------------------------------------------------------
const LOCATION_FIELDS = ['name', 'kind', 'isColdChain', 'isDispensing'];
const validateLocation = async (data) => {
  if (!String(data.kind || '').trim()) return 'Location kind is required';
  return null;
};
const locationsCrud = crudFor(StockLocation, {
  label: 'location',
  fields: LOCATION_FIELDS,
  validate: validateLocation,
  stockHeld: stockHeldByLocation,
});

const SUPPLIER_FIELDS = ['name', 'contactPhone', 'contactEmail'];
const suppliersCrud = crudFor(Supplier, { label: 'supplier', fields: SUPPLIER_FIELDS });

module.exports = {
  listItems,
  createItem: itemsCrud.create,
  updateItem: itemsCrud.update,
  listLocations: locationsCrud.list,
  createLocation: locationsCrud.create,
  updateLocation: locationsCrud.update,
  listSuppliers: suppliersCrud.list,
  createSupplier: suppliersCrud.create,
  updateSupplier: suppliersCrud.update,
};
