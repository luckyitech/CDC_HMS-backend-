const { success, error } = require('../utils/response');
const db = require('../models');

const { LabPackage, CatalogItem, User } = db;

// Effective price of a package: a fixed special rate, or the sum of its members.
const effectivePrice = (pkg) => {
  const tests = pkg.tests || [];
  const sum = tests.reduce((t, m) => t + (m.price != null ? Number(m.price) : 0), 0);
  if (pkg.priceMode === 'fixed' && pkg.fixedPrice != null) return Number(pkg.fixedPrice);
  return sum;
};

const formatPackage = (pkg) => {
  const tests = (pkg.tests || []).map((m) => ({
    id: m.id,
    name: m.name,
    sampleType: m.detail || null,   // labTest catalogue stores sample type in `detail`
    price: m.price != null ? Number(m.price) : null,
  }));
  const sum = tests.reduce((t, m) => t + (m.price || 0), 0);
  return {
    id: pkg.id,
    name: pkg.name,
    priceMode: pkg.priceMode,
    fixedPrice: pkg.fixedPrice != null ? Number(pkg.fixedPrice) : null,
    isCommon: !!pkg.isCommon,
    status: pkg.status,
    tests,
    sumOfTests: sum,
    price: effectivePrice(pkg),      // what the clinician sees for the package
    addedBy: pkg.addedBy,
  };
};

const withTests = {
  include: [{ model: CatalogItem, as: 'tests', through: { attributes: [] }, attributes: ['id', 'name', 'detail', 'price'] }],
};

const archiverName = async (userId) => {
  const user = await User.findByPk(userId, { attributes: ['firstName', 'lastName'] });
  return user ? `${user.firstName} ${user.lastName}` : null;
};

// Resolve + validate an array of labTest catalogue ids. Returns { ok, ids } or
// { ok:false, message }.
const resolveTestIds = async (testIds) => {
  if (!Array.isArray(testIds) || testIds.length === 0) {
    return { ok: false, message: 'A package must contain at least one test' };
  }
  const ids = [...new Set(testIds.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)))];
  const found = await CatalogItem.findAll({ where: { id: ids, type: 'labTest' }, attributes: ['id'] });
  if (found.length !== ids.length) {
    return { ok: false, message: 'One or more tests are not valid lab-test catalogue entries' };
  }
  return { ok: true, ids };
};

/**
 * GET /api/lab-packages?all=1
 * Lists packages with their member tests. Active only by default; ?all=1 returns
 * archived too (admin manager). Used by the request form and the admin page.
 */
const list = async (req, res) => {
  try {
    const where = req.query.all ? {} : { status: 'active' };
    const packages = await LabPackage.findAll({ where, order: [['name', 'ASC']], ...withTests });
    return success(res, { packages: packages.map(formatPackage) });
  } catch (err) {
    console.error('LabPackage.list error:', err);
    return error(res, 'Failed to load lab packages', 500);
  }
};

/**
 * POST /api/lab-packages — admin only
 * { name, priceMode?, fixedPrice?, isCommon?, testIds: number[] }
 */
const create = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return error(res, 'Package name is required', 400);

    const priceMode = req.body.priceMode === 'fixed' ? 'fixed' : 'sum';
    const fixedPrice = priceMode === 'fixed'
      ? (req.body.fixedPrice != null && req.body.fixedPrice !== '' ? Number(req.body.fixedPrice) : null)
      : null;
    if (priceMode === 'fixed' && (fixedPrice == null || Number.isNaN(fixedPrice) || fixedPrice < 0)) {
      return error(res, 'A special-rate package needs a valid price', 400);
    }

    const resolved = await resolveTestIds(req.body.testIds);
    if (!resolved.ok) return error(res, resolved.message, 400);

    const existing = await LabPackage.findOne({ where: { name } });
    if (existing) return error(res, `A package named '${name}' already exists`, 409);

    const pkg = await LabPackage.create({
      name,
      priceMode,
      fixedPrice,
      isCommon: !!req.body.isCommon,
      addedBy: await archiverName(req.user.id),
    });
    await pkg.setTests(resolved.ids);

    const full = await LabPackage.findByPk(pkg.id, withTests);
    return success(res, formatPackage(full), 201);
  } catch (err) {
    console.error('LabPackage.create error:', err);
    return error(res, 'Failed to create lab package', 500);
  }
};

/**
 * PUT /api/lab-packages/:id — admin only
 */
const update = async (req, res) => {
  try {
    const pkg = await LabPackage.findByPk(req.params.id);
    if (!pkg) return error(res, 'Package not found', 404);

    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return error(res, 'Package name cannot be empty', 400);
      const clash = await LabPackage.findOne({ where: { name } });
      if (clash && clash.id !== pkg.id) return error(res, `A package named '${name}' already exists`, 409);
      updates.name = name;
    }
    if (req.body.priceMode !== undefined) {
      updates.priceMode = req.body.priceMode === 'fixed' ? 'fixed' : 'sum';
    }
    const nextMode = updates.priceMode || pkg.priceMode;
    if (req.body.fixedPrice !== undefined || updates.priceMode) {
      if (nextMode === 'fixed') {
        const fp = req.body.fixedPrice != null && req.body.fixedPrice !== '' ? Number(req.body.fixedPrice) : null;
        if (fp == null || Number.isNaN(fp) || fp < 0) return error(res, 'A special-rate package needs a valid price', 400);
        updates.fixedPrice = fp;
      } else {
        updates.fixedPrice = null;
      }
    }
    if (req.body.isCommon !== undefined) updates.isCommon = !!req.body.isCommon;
    if (req.body.status !== undefined && ['active', 'archived'].includes(req.body.status)) {
      updates.status = req.body.status;
    }

    await pkg.update(updates);

    if (req.body.testIds !== undefined) {
      const resolved = await resolveTestIds(req.body.testIds);
      if (!resolved.ok) return error(res, resolved.message, 400);
      await pkg.setTests(resolved.ids);
    }

    const full = await LabPackage.findByPk(pkg.id, withTests);
    return success(res, formatPackage(full));
  } catch (err) {
    console.error('LabPackage.update error:', err);
    return error(res, 'Failed to update lab package', 500);
  }
};

/**
 * DELETE /api/lab-packages/:id — admin only
 * Removes the package definition. Existing lab requests are unaffected — they
 * snapshot packageName/packageRate at order time.
 */
const destroy = async (req, res) => {
  try {
    const pkg = await LabPackage.findByPk(req.params.id);
    if (!pkg) return error(res, 'Package not found', 404);
    await pkg.destroy();   // LabPackageItems cascade
    return success(res, { message: 'Package removed' });
  } catch (err) {
    console.error('LabPackage.destroy error:', err);
    return error(res, 'Failed to remove lab package', 500);
  }
};

module.exports = { list, create, update, destroy };
