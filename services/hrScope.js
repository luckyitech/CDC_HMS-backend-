// Department scopes on HR controls — the DB side (HR Tier 3 Phase 1). The rules
// are pure in utils/hrScope.js; this file loads what they need and is the ONE
// place every HR list and action asks "may this person do X to that person?".
//
//   scopeOf(user, cap)                → { all, departmentIds }
//   canActOn(user, cap, targetUserId) → may act on this one person (out of
//                                       scope reads as "not found" to callers)
//   userIdsInScope(user, cap)         → null (no limit) or [userIds] for a list
//   holdersFor(cap, targetUserId)     → who should hear about this person
//                                       (alerts follow scope — L-6)
//   scopesFor(userId) / saveScopes()  → the Permissions tab's read and write
//
// A person's scope rows and own department are loaded once per request and
// cached on the req.user object (authenticate builds a fresh one per request).

const { Op } = require('sequelize');
const db = require('../models');
const { SCOPABLE, passesAdminGate, INTERNAL_ROLES } = require('../constants/permissions');
const {
  resolveScope, mayBeScoped, inScope, specOfRows, rowsOfSpec, NONE,
} = require('../utils/hrScope');

const CACHE = Symbol('hrScopeContext');

/** The person's own department id (or null). */
const departmentOf = async (userId, { transaction } = {}) => {
  if (!userId) return null;
  const p = await db.StaffProfile.findOne({ where: { UserId: userId }, attributes: ['departmentId'], transaction });
  return p?.departmentId ?? null;
};

/** Department ids for many people at once: Map userId → departmentId|null. */
const departmentsOf = async (userIds) => {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return map;
  const rows = await db.StaffProfile.findAll({ where: { UserId: { [Op.in]: ids } }, attributes: ['UserId', 'departmentId'] });
  rows.forEach((r) => map.set(Number(r.UserId), r.departmentId ?? null));
  return map;
};

const contextOf = async (user) => {
  if (user[CACHE]) return user[CACHE];
  const [rows, ownDepartmentId] = await Promise.all([
    db.PermissionScope.findAll({ where: { UserId: user.id }, attributes: ['capability', 'kind', 'departmentId'], raw: true }),
    departmentOf(user.id),
  ]);
  // Not enumerable: never serialised into a response or a log.
  Object.defineProperty(user, CACHE, { value: { rows, ownDepartmentId }, enumerable: false, configurable: true });
  return user[CACHE];
};

const scopeOf = async (user, capability) => {
  if (!user || !passesAdminGate(user, capability)) return NONE();
  if (!mayBeScoped(user, capability)) return resolveScope({ user, capability });
  const { rows, ownDepartmentId } = await contextOf(user);
  return resolveScope({ user, capability, rows, ownDepartmentId });
};

/** May `user` use `capability` on the person `targetUserId`? */
const canActOn = async (user, capability, targetUserId, { targetDepartmentId } = {}) => {
  const scope = await scopeOf(user, capability);
  if (scope.all) return true;
  if (!scope.departmentIds.size) return false;
  const dept = targetDepartmentId !== undefined ? targetDepartmentId : await departmentOf(targetUserId);
  return inScope(scope, dept);
};

/** Any of several capabilities (e.g. staff.view OR hr.expiry.alerts). */
const canActOnAny = async (user, capabilities, targetUserId) => {
  const dept = await departmentOf(targetUserId);
  for (const cap of capabilities) {
    if (await canActOn(user, cap, targetUserId, { targetDepartmentId: dept })) return true;
  }
  return false;
};

/**
 * The people a list may show: null = no limit, else the user ids whose
 * department is inside the scope (possibly empty). Pass several capabilities
 * for "either" — the union.
 */
const userIdsInScope = async (user, capabilities) => {
  const caps = Array.isArray(capabilities) ? capabilities : [capabilities];
  const depts = new Set();
  for (const cap of caps) {
    const scope = await scopeOf(user, cap);
    if (scope.all) return null;
    scope.departmentIds.forEach((d) => depts.add(d));
  }
  if (!depts.size) return [];
  const rows = await db.StaffProfile.findAll({
    where: { departmentId: { [Op.in]: [...depts] } }, attributes: ['UserId'], raw: true,
  });
  return rows.map((r) => Number(r.UserId));
};

/** A Sequelize where-fragment for a column holding user ids, or {} for no limit. */
const scopeWhere = async (user, capabilities, column = 'UserId') => {
  const ids = await userIdsInScope(user, capabilities);
  return ids === null ? {} : { [column]: { [Op.in]: ids } };
};

/** Keep only the items whose person is in scope (getUserId picks the id). */
const filterInScope = async (user, capabilities, items, getUserId = (x) => x.UserId) => {
  const ids = await userIdsInScope(user, capabilities);
  if (ids === null) return items;
  const allowed = new Set(ids);
  return items.filter((x) => allowed.has(Number(getUserId(x))));
};

/** Every active internal account holding `capability` whose scope covers this person. */
const holdersFor = async (capability, targetUserId) => {
  const staff = await db.User.findAll({
    where: { role: { [Op.in]: INTERNAL_ROLES }, isActive: true },
    attributes: ['id', 'role', 'permissions', 'deniedPermissions', 'staffType'],
  });
  const dept = await departmentOf(targetUserId);
  const out = [];
  for (const u of staff) {
    if (!passesAdminGate(u, capability)) continue;
    if (await canActOn(u, capability, targetUserId, { targetDepartmentId: dept })) out.push(u.id);
  }
  return out;
};

/** One person's stored scopes: { capability: spec } for every SCOPABLE control. */
const scopesFor = async (userId, { transaction } = {}) => {
  const rows = await db.PermissionScope.findAll({ where: { UserId: userId }, raw: true, transaction });
  return Object.fromEntries(SCOPABLE.map((cap) => [cap, specOfRows(rows.filter((r) => r.capability === cap))]));
};

/**
 * Replace the stored scope of the given controls (specs already cleaned and
 * permitted by the caller). The ONLY writer of PermissionScopes.
 * @param changes { capability: spec }
 */
const saveScopes = async (userId, changes, actorId, { transaction } = {}) => {
  for (const [capability, spec] of Object.entries(changes)) {
    if (!SCOPABLE.includes(capability)) continue;
    await db.PermissionScope.destroy({ where: { UserId: userId, capability }, transaction });
    const rows = rowsOfSpec(spec);
    if (rows.length) {
      await db.PermissionScope.bulkCreate(
        rows.map((r) => ({ UserId: userId, capability, kind: r.kind, departmentId: r.departmentId, setById: actorId })),
        { transaction },
      );
    }
  }
};

module.exports = {
  departmentOf, departmentsOf, scopeOf, canActOn, canActOnAny,
  userIdsInScope, scopeWhere, filterInScope, holdersFor, scopesFor, saveScopes,
};
