const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');
const {
  PRESET_EXCLUDED, PRESET_ROLES, STAFF_TYPES, reconcilePermissionLists, toList,
} = require('../constants/permissions');

const { PermissionPreset, User } = db;

// =====================================================================
// Permission presets — the growable list of job shapes the clinic hires for.
//
// Reads are open to anyone who can view users (the wizard needs the list);
// every write sits behind requireTrueAdmin (= canGrantPermissions) because
// defining a bundle of grants IS a grant decision: a users.write holder may
// later apply it unchanged without a key-holder present (decision of record,
// 24 Sep 2026), so what goes into it has to be a key-holder's call.
//
// Three capabilities may never be stored here — PRESET_EXCLUDED — and a
// payload carrying one is refused rather than silently stripped, so an admin
// building a "Practice manager" preset learns at once that administrator
// access is a per-person act, not a template.
// =====================================================================

const AUTHOR = { model: User, attributes: ['id', 'firstName', 'lastName'] };

const formatPreset = (p) => ({
  id:                p.id,
  name:              p.name,
  description:       p.description,
  baseRole:          p.baseRole,
  staffType:         p.staffType,
  position:          p.position,
  department:        p.department,
  permissions:       toList(p.permissions),
  deniedPermissions: toList(p.deniedPermissions),
  status:            p.status,
  appliedCount:      p.appliedCount,
  createdBy:         p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : null,
  updatedBy:         p.updatedBy ? `${p.updatedBy.firstName} ${p.updatedBy.lastName}` : null,
  createdAt:         p.createdAt,
  updatedAt:         p.updatedAt,
});

/**
 * Validate and normalise a preset payload. Returns { fields } or { message }.
 * Pure — unit-tested without a DB (tests/permissionPresets.test.js).
 */
const validatePresetPayload = (body) => {
  const name = String(body.name || '').trim();
  if (!name) return { message: 'A preset needs a name' };
  if (name.length > 80) return { message: 'Preset name is too long (80 characters max)' };
  if (!PRESET_ROLES.includes(body.baseRole)) {
    return { message: `baseRole must be one of ${PRESET_ROLES.join(', ')}` };
  }
  const staffType = body.staffType === undefined ? STAFF_TYPES.CLINICAL : body.staffType;
  if (!Object.values(STAFF_TYPES).includes(staffType)) {
    return { message: 'staffType must be clinical or non_clinical' };
  }
  const requested = [...toList(body.permissions), ...toList(body.deniedPermissions)];
  const excluded = requested.filter((p) => PRESET_EXCLUDED.includes(p));
  if (excluded.length) {
    return {
      message: `${excluded.join(', ')} cannot be part of a preset — it is granted per person, by a permissions administrator`,
    };
  }
  const { granted, denied } = reconcilePermissionLists(toList(body.permissions), toList(body.deniedPermissions));
  return {
    fields: {
      name,
      description: body.description ? String(body.description).trim() : null,
      baseRole:    body.baseRole,
      staffType,
      position:    body.position ? String(body.position).trim() : null,
      department:  body.department ? String(body.department).trim() : null,
      permissions:       granted,
      deniedPermissions: denied,
    },
  };
};

// Uniqueness among ACTIVE presets only — an archived one's name may be reused.
const nameTaken = async (name, exceptId) => {
  const where = { name, status: 'active' };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  return !!(await PermissionPreset.findOne({ where }));
};

const load = (id) => PermissionPreset.findByPk(id, {
  include: [{ ...AUTHOR, as: 'createdBy' }, { ...AUTHOR, as: 'updatedBy' }],
});

/** GET /api/permission-presets — active by default; ?includeArchived=1 for Settings. */
const list = async (req, res) => {
  try {
    const where = req.query.includeArchived === '1' ? {} : { status: 'active' };
    if (req.query.baseRole) where.baseRole = req.query.baseRole;
    const rows = await PermissionPreset.findAll({
      where,
      include: [{ ...AUTHOR, as: 'createdBy' }, { ...AUTHOR, as: 'updatedBy' }],
      order: [['status', 'ASC'], ['name', 'ASC']],
    });
    return success(res, rows.map(formatPreset));
  } catch (err) {
    console.error('PermissionPreset.list error:', err);
    return error(res, 'Failed to load permission presets', 500);
  }
};

/** POST /api/permission-presets */
const create = async (req, res) => {
  try {
    const { fields, message } = validatePresetPayload(req.body);
    if (message) return error(res, message, 400);
    if (await nameTaken(fields.name)) return error(res, `A preset called "${fields.name}" already exists`, 400);

    const row = await PermissionPreset.create({ ...fields, createdById: req.user.id, updatedById: req.user.id });
    return success(res, formatPreset(await load(row.id)), 201);
  } catch (err) {
    console.error('PermissionPreset.create error:', err);
    return error(res, 'Failed to create the preset', 500);
  }
};

/** PUT /api/permission-presets/:id — future hires only; nobody already created changes. */
const update = async (req, res) => {
  try {
    const row = await PermissionPreset.findByPk(req.params.id);
    if (!row) return error(res, 'Preset not found', 404);
    if (row.status === 'archived') return error(res, 'Restore this preset before editing it', 400);

    const { fields, message } = validatePresetPayload({ ...formatPreset(row), ...req.body });
    if (message) return error(res, message, 400);
    if (await nameTaken(fields.name, row.id)) return error(res, `A preset called "${fields.name}" already exists`, 400);

    await row.update({ ...fields, updatedById: req.user.id });
    return success(res, formatPreset(await load(row.id)));
  } catch (err) {
    console.error('PermissionPreset.update error:', err);
    return error(res, 'Failed to update the preset', 500);
  }
};

const setStatus = (status) => async (req, res) => {
  try {
    const row = await PermissionPreset.findByPk(req.params.id);
    if (!row) return error(res, 'Preset not found', 404);
    if (status === 'active' && await nameTaken(row.name, row.id)) {
      return error(res, `Another active preset is already called "${row.name}" — rename it first`, 400);
    }
    await row.update({ status, updatedById: req.user.id });
    return success(res, formatPreset(await load(row.id)));
  } catch (err) {
    console.error(`PermissionPreset.${status === 'archived' ? 'archive' : 'restore'} error:`, err);
    return error(res, 'Failed to change the preset', 500);
  }
};

module.exports = {
  list,
  create,
  update,
  archive: setStatus('archived'),
  restore: setStatus('active'),
  // exported for tests
  validatePresetPayload,
  formatPreset,
};
