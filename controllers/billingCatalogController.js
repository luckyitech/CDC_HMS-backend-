const { Op } = require('sequelize');
const { success } = require('../utils/response');
const { action, readAmount, serviceItemFor } = require('../utils/billingHttp');
const { BillingError } = require('../utils/billingLedger');
const {
  VAT_CLASS_VALUES, SERVICE_CATEGORY_VALUES, DEFAULT_VAT_CLASS,
} = require('../constants/billing');
const db = require('../models');

const { ServiceItem, ServicePriceChange, InvoiceLine, StockItem, User } = db;

// =====================================================================
// The price list — what the clinic sells and what it costs.
//
// Deliberately NOT folded into the CatalogItem table that holds medications and
// diagnoses: those are a clinical vocabulary with no commercial meaning, and a
// price column on them would be readable by every clinical screen in the app.
// Money lives behind its own permission.
//
// Retired, never deleted. A service that has ever been billed must stay
// resolvable for as long as its invoices exist — the same rule the stock module
// applies to StockItem.
// =====================================================================

const ATTRIBUTION_INCLUDE = [
  { model: User, as: 'addedByUser', attributes: ['id', 'firstName', 'lastName'] },
  { model: User, as: 'updatedByUser', attributes: ['id', 'firstName', 'lastName'] },
  { model: StockItem, as: 'stockItem', attributes: ['id', 'name', 'unit'] },
];

// Fields a client may set, and how each is validated. One table drives create
// and update alike, so the two can never disagree about what is allowed.
const FIELDS = {
  name: {
    parse: (raw) => String(raw ?? '').trim(),
    validate: (v) => (v ? null : 'Name is required'),
  },
  code: {
    parse: (raw) => String(raw ?? '').trim().toUpperCase() || null,
    validate: () => null,
  },
  category: {
    parse: (raw) => String(raw ?? '').trim(),
    validate: (v) => (SERVICE_CATEGORY_VALUES.includes(v)
      ? null
      : `Category must be one of: ${SERVICE_CATEGORY_VALUES.join(', ')}`),
  },
  description: {
    parse: (raw) => String(raw ?? '').trim() || null,
    validate: () => null,
  },
  vatClass: {
    parse: (raw) => String(raw ?? '').trim(),
    validate: (v) => (VAT_CLASS_VALUES.includes(v)
      ? null
      : `VAT class must be one of: ${VAT_CLASS_VALUES.join(', ')}`),
  },
  status: {
    parse: (raw) => String(raw ?? '').trim(),
    validate: (v) => (['active', 'retired'].includes(v) ? null : "Status must be 'active' or 'retired'"),
  },
  stockItemId: {
    parse: (raw) => (raw === null || raw === '' ? null : Number(raw)),
    validate: (v) => (v === null || Number.isInteger(v) ? null : 'stockItemId must be a number'),
  },
};

/**
 * Build the patch from a request body: only fields actually supplied, each
 * validated. Price is handled separately because it is money and arrives as a
 * decimal string.
 */
const patchFrom = (body) => {
  const patch = {};

  Object.entries(FIELDS).forEach(([field, spec]) => {
    if (!(field in body)) return;
    const value = spec.parse(body[field]);
    const message = spec.validate(value);
    if (message) throw new BillingError(message);
    patch[field] = value;
  });

  // `unitPrice` is the decimal a human typed; unitPriceMinor is what is stored.
  // An explicit null CLEARS the price back to "not yet priced", which is how an
  // admin marks a service as needing a decision rather than being free.
  if ('unitPrice' in body) {
    patch.unitPriceMinor = body.unitPrice === null || body.unitPrice === ''
      ? null
      : readAmount(body, 'unitPrice', { label: 'Price' });
  }

  return patch;
};

/**
 * GET /api/billing/services
 *
 * Readable by any clinical role — the doctor's charge list is built from it.
 * Prices are stripped for anyone without billing.viewPrices, on the way out.
 */
const list = action('Billing.services.list', async (req, res) => {
  const where = {};
  if (req.query.includeRetired !== 'true') where.status = 'active';
  if (req.query.category) where.category = req.query.category;
  if (req.query.q) where.name = { [Op.like]: `%${req.query.q}%` };
  // The checkout resolves a scanned batch to a price through this.
  if (req.query.stockItemId) where.stockItemId = Number(req.query.stockItemId);

  const rows = await ServiceItem.findAll({
    where,
    include: ATTRIBUTION_INCLUDE,
    order: [['category', 'ASC'], ['name', 'ASC']],
  });

  return success(res, rows.map((row) => serviceItemFor(req.user, row)));
});

// ---------------------------------------------------------------------
// Price history
//
// ServiceItem records who last edited it and when. It does not record WHAT
// CHANGED, and that gap is what this closes:
//
//   Drop HbA1c from 3,500 to 500. Bill the patient 500 officially, take 3,500
//   in cash, keep the difference. Restore the price five minutes later. The
//   activity log shows two edits by that person, NEITHER carrying an amount,
//   and every invoice raised in between is arithmetically perfect.
//
// A row per change makes the dip visible. Written for price, VAT class and
// status — the three things that decide what a patient is charged and whether
// they can be charged at all. Renames are not commercial and are not tracked.
// ---------------------------------------------------------------------
const TRACKED = [
  ['unitPriceMinor', 'oldPriceMinor', 'newPriceMinor'],
  ['vatClass', 'oldVatClass', 'newVatClass'],
  ['status', 'oldStatus', 'newStatus'],
];

/**
 * Write a history row if anything commercial actually changed.
 *
 * Called with the values read BEFORE the update. Returns the row, or null when
 * the edit touched only the name or the code — recording a change that did not
 * happen would bury the ones that did.
 */
const recordPriceChange = async (before, after, userId) => {
  const changed = TRACKED.filter(([field]) => String(before[field]) !== String(after[field]));
  if (!changed.length) return null;

  const entry = { serviceItemId: after.id, changedById: userId || null };
  // Both sides of EVERY tracked field, not only the ones that moved, so a row
  // reads on its own without reconstructing the sequence before it.
  TRACKED.forEach(([field, oldKey, newKey]) => {
    entry[oldKey] = before[field];
    entry[newKey] = after[field];
  });

  return ServicePriceChange.create(entry);
};

/** POST /api/billing/services */
const create = action('Billing.services.create', async (req, res) => {
  const patch = patchFrom(req.body);
  if (!patch.name) throw new BillingError('Name is required');

  // A service must arrive with a price. Nothing may be added to the price list
  // that reception then cannot bill — an unpriced service silently blocks a
  // whole visit's invoice at the desk, where nobody can fix it.
  //
  // 0 is a legitimate price and passes: it means the clinic gives this away.
  // Only "nobody decided" is refused.
  if (patch.unitPriceMinor === null || patch.unitPriceMinor === undefined) {
    throw new BillingError('A price is required — use 0 if the service is free');
  }

  const row = await ServiceItem.create({
    category: 'other',
    vatClass: DEFAULT_VAT_CLASS,
    status: 'active',
    ...patch,
    addedById: req.user.id,
    lastUpdatedById: req.user.id,
  }).catch((err) => {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new BillingError('A service with that name or code already exists');
    }
    throw err;
  });

  const created = await ServiceItem.findByPk(row.id, { include: ATTRIBUTION_INCLUDE });
  return success(res, serviceItemFor(req.user, created), 201);
});

/**
 * PUT /api/billing/services/:id
 *
 * Renaming is allowed and safe for history — invoice lines snapshot their
 * description — but it does break the name-matching that resolves a visit's
 * charge labels to price list rows, so a visit already waiting at the checkout
 * would no longer find the renamed service. Reception can always add the line
 * by hand, and the alternative (forbidding renames outright) makes fixing a
 * typo impossible.
 */
const update = action('Billing.services.update', async (req, res) => {
  const row = await ServiceItem.findByPk(req.params.id);
  if (!row) throw new BillingError('Service not found', 404);

  const patch = patchFrom(req.body);
  if ('name' in patch && !patch.name) throw new BillingError('Name is required');

  // A price may be changed but not removed. Clearing one would make the service
  // unbillable at the desk, where nobody has the rights to put it back.
  if ('unitPriceMinor' in patch && patch.unitPriceMinor === null) {
    throw new BillingError('A price is required — use 0 if the service is free');
  }

  // Read before the write: the history row needs both sides.
  const before = {
    unitPriceMinor: row.unitPriceMinor,
    vatClass: row.vatClass,
    status: row.status,
  };

  await row.update({ ...patch, lastUpdatedById: req.user.id }).catch((err) => {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw new BillingError('A service with that name or code already exists');
    }
    throw err;
  });

  await recordPriceChange(before, row, req.user.id);

  const updated = await ServiceItem.findByPk(row.id, { include: ATTRIBUTION_INCLUDE });
  return success(res, serviceItemFor(req.user, updated));
});

/**
 * DELETE /api/billing/services/:id — retire, never destroy.
 *
 * A service that has been billed is kept for its invoices; one that never was
 * is still only retired, so the two behave the same way and nobody has to learn
 * which is which.
 */
const retire = action('Billing.services.retire', async (req, res) => {
  const row = await ServiceItem.findByPk(req.params.id);
  if (!row) throw new BillingError('Service not found', 404);

  const billed = await InvoiceLine.count({ where: { serviceItemId: row.id } });

  const before = { unitPriceMinor: row.unitPriceMinor, vatClass: row.vatClass, status: row.status };
  await row.update({ status: 'retired', lastUpdatedById: req.user.id });
  // Retiring is a commercial change — it stops the service being sellable — so
  // it belongs in the same history as a price move.
  await recordPriceChange(before, row, req.user.id);

  return success(res, {
    message: billed
      ? `${row.name} retired. It stays on the ${billed} invoice line(s) that already used it.`
      : `${row.name} retired.`,
  });
});

module.exports = { list, create, update, retire };
