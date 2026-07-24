const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { DRUG_CLASS_VALUES } = require('../constants/drugClasses');
const db = require('../models');

const { CatalogItem, Setting, User } = db;

// Drug class only applies to medications. Returns { ok, value } or { ok:false,
// message } — null clears it, an unknown value is rejected.
const normalizeDrugClass = (type, raw) => {
  if (type !== 'medication' || raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (!DRUG_CLASS_VALUES.includes(raw)) {
    return { ok: false, message: `Unknown drug class '${raw}'` };
  }
  return { ok: true, value: raw };
};

// One controller serves every catalog type. Add a type here (and to the
// model enum) and the whole API + admin UI picks it up.
const VALID_TYPES = ['medication', 'diagnosis'];

// Where the autocomplete suggestions come from, per catalog type:
//   'external' — the public NIH APIs (RxNorm / ICD-10), the default until
//                the clinic finishes entering its own lists
//   'catalog'  — the admin-managed lists in this database
const VALID_SOURCES = ['catalog', 'external'];
const DEFAULT_SOURCE = 'external';
const sourceKey = (type) => `catalogSource.${type}`;

// All handlers run behind this — req.catalogType is the validated type.
const validateType = (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    return error(res, `Unknown catalog type '${type}'. Valid types: ${VALID_TYPES.join(', ')}`, 400);
  }
  req.catalogType = type;
  next();
};

const formatItem = (item) => ({
  id: item.id,
  name: item.name,
  detail: item.detail,
  drugClass: item.drugClass || null,
  addedBy: item.addedBy,
  createdAt: item.createdAt,
});

const cleanName = (value) => String(value ?? '').trim();

const archiverName = async (userId) => {
  const user = await User.findByPk(userId, { attributes: ['firstName', 'lastName'] });
  return user ? `${user.firstName} ${user.lastName}` : null;
};

/**
 * GET /api/catalog/:type?search=&limit=
 * List/search catalog entries. Used by the admin manager (no search = all)
 * and by the autocomplete inputs (search + small limit).
 *
 * Authorization: any signed-in clinical role
 */
const list = async (req, res) => {
  try {
    const { search, limit } = req.query;
    const where = { type: req.catalogType };
    if (search) where.name = { [Op.like]: `%${search}%` };

    const items = await CatalogItem.findAll({
      where,
      order: [['name', 'ASC']],
      ...(limit ? { limit: Math.min(parseInt(limit, 10) || 10, 50) } : {}),
    });

    return success(res, { items: items.map(formatItem), total: items.length });
  } catch (err) {
    console.error('catalog list error:', err);
    return error(res, 'Failed to load catalog', 500);
  }
};

/**
 * POST /api/catalog/:type — add one entry { name, detail? }
 * Authorization: admin
 */
const create = async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const detail = cleanName(req.body.detail) || null;
    if (!name) return error(res, 'Name is required', 400);
    if (name.length > 255) return error(res, 'Name is too long (maximum 255 characters)', 400);

    const drugClass = normalizeDrugClass(req.catalogType, req.body.drugClass);
    if (!drugClass.ok) return error(res, drugClass.message, 400);

    const existing = await CatalogItem.findOne({ where: { type: req.catalogType, name } });
    if (existing) return error(res, `'${name}' is already in this catalog`, 409);

    const item = await CatalogItem.create({
      type: req.catalogType,
      name,
      detail,
      drugClass: drugClass.value,
      addedBy: await archiverName(req.user.id),
    });

    return success(res, formatItem(item), 201);
  } catch (err) {
    console.error('catalog create error:', err);
    return error(res, 'Failed to add catalog entry', 500);
  }
};

/**
 * POST /api/catalog/:type/bulk — add many entries { names: string[] }
 * Skips blanks and entries that already exist; reports what happened.
 * Authorization: admin
 */
const bulkCreate = async (req, res) => {
  try {
    const { names } = req.body;
    if (!Array.isArray(names) || names.length === 0) {
      return error(res, "Provide 'names' as a non-empty array of strings", 400);
    }
    if (names.length > 500) {
      return error(res, 'Maximum 500 entries per bulk add', 400);
    }

    // Dedupe within the submission (case-insensitive), drop blanks/overlong
    const seen = new Set();
    const candidates = [];
    for (const raw of names) {
      const name = cleanName(raw);
      const key = name.toLowerCase();
      if (!name || name.length > 255 || seen.has(key)) continue;
      seen.add(key);
      candidates.push(name);
    }
    if (candidates.length === 0) return error(res, 'No valid names in the list', 400);

    const existing = await CatalogItem.findAll({
      where: { type: req.catalogType, name: { [Op.in]: candidates } },
      attributes: ['name'],
    });
    const existingSet = new Set(existing.map((e) => e.name.toLowerCase()));
    const toInsert = candidates.filter((n) => !existingSet.has(n.toLowerCase()));

    const addedBy = await archiverName(req.user.id);
    const created = await CatalogItem.bulkCreate(
      toInsert.map((name) => ({ type: req.catalogType, name, addedBy }))
    );

    return success(res, {
      added: created.length,
      skippedExisting: candidates.length - toInsert.length,
      items: created.map(formatItem),
    }, 201);
  } catch (err) {
    console.error('catalog bulk create error:', err);
    return error(res, 'Failed to add catalog entries', 500);
  }
};

/**
 * PUT /api/catalog/:type/:id — update { name?, detail? }
 * Authorization: admin
 */
const update = async (req, res) => {
  try {
    const item = await CatalogItem.findOne({ where: { id: req.params.id, type: req.catalogType } });
    if (!item) return error(res, 'Catalog entry not found', 404);

    const updates = {};
    if (req.body.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return error(res, 'Name cannot be empty', 400);
      if (name.length > 255) return error(res, 'Name is too long (maximum 255 characters)', 400);
      const clash = await CatalogItem.findOne({
        where: { type: req.catalogType, name, id: { [Op.ne]: item.id } },
      });
      if (clash) return error(res, `'${name}' is already in this catalog`, 409);
      updates.name = name;
    }
    if (req.body.detail !== undefined) {
      updates.detail = cleanName(req.body.detail) || null;
    }
    if (req.body.drugClass !== undefined) {
      const drugClass = normalizeDrugClass(req.catalogType, req.body.drugClass);
      if (!drugClass.ok) return error(res, drugClass.message, 400);
      updates.drugClass = drugClass.value;
    }

    await item.update(updates);
    return success(res, formatItem(item));
  } catch (err) {
    console.error('catalog update error:', err);
    return error(res, 'Failed to update catalog entry', 500);
  }
};

/**
 * DELETE /api/catalog/:type/:id
 * Safe to delete — prescriptions/plans store text, not references.
 * Authorization: admin
 */
const destroy = async (req, res) => {
  try {
    const item = await CatalogItem.findOne({ where: { id: req.params.id, type: req.catalogType } });
    if (!item) return error(res, 'Catalog entry not found', 404);
    await item.destroy();
    return success(res, { message: 'Catalog entry removed' });
  } catch (err) {
    console.error('catalog delete error:', err);
    return error(res, 'Failed to remove catalog entry', 500);
  }
};

/**
 * GET /api/catalog/sources
 * Which suggestion source each catalog type currently uses.
 * Authorization: any signed-in clinical role (the inputs need it)
 */
const getSources = async (req, res) => {
  try {
    const rows = await Setting.findAll({
      where: { key: VALID_TYPES.map(sourceKey) },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const sources = Object.fromEntries(
      VALID_TYPES.map((type) => [type, byKey.get(sourceKey(type)) || DEFAULT_SOURCE])
    );
    return success(res, sources);
  } catch (err) {
    console.error('catalog getSources error:', err);
    return error(res, 'Failed to load catalog sources', 500);
  }
};

/**
 * PUT /api/catalog/:type/source — { source: 'catalog' | 'external' }
 * Authorization: admin
 */
const setSource = async (req, res) => {
  try {
    const { source } = req.body;
    if (!VALID_SOURCES.includes(source)) {
      return error(res, `Invalid source '${source}'. Valid sources: ${VALID_SOURCES.join(', ')}`, 400);
    }
    const key = sourceKey(req.catalogType);
    const existing = await Setting.findOne({ where: { key } });
    if (existing) await existing.update({ value: source });
    else await Setting.create({ key, value: source });

    return success(res, { type: req.catalogType, source });
  } catch (err) {
    console.error('catalog setSource error:', err);
    return error(res, 'Failed to update catalog source', 500);
  }
};

module.exports = { validateType, list, create, bulkCreate, update, destroy, getSources, setSource };
