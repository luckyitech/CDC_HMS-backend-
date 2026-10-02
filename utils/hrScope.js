// Department scopes on HR controls — the PURE rules (HR Tier 3 Phase 1,
// decisions P-1/P-7/P-8 and L-5…L-8, Emu 2 Oct 2026). The DB side (loading a
// person's scope rows, saving them, finding who is in a department) is
// services/hrScope.js; every HR list and action asks through it.
//
// A scope is { all: boolean, departmentIds: Set<number> }.
//
// How a person's scope on one control is worked out (resolveScope):
//   - They must hold the control at all (passesAdminGate) — otherwise NONE.
//   - The true admin account, and full administrator access, are ALL STAFF
//     (admin.access is never department-limited).
//   - Otherwise every stored grant that yields the control contributes: the
//     control ticked directly, or a broader one that CARRIES it (leave.manage
//     carries leave.sick) — a carried control follows the scope of what
//     carries it. A grant with no scope rows is ALL STAFF (what every grant
//     meant before this phase). The widest source wins (union).
//   - Held some other way (a role default) → ALL STAFF.
//   - "Own department" resolves to the holder's department NOW, so it follows
//     them when they move; a holder with no department gets nothing from it.
//
// Someone with no department on their file is in nobody's limited scope —
// visible only to "All staff" holders (P-8).

const {
  PERMISSIONS, LEGACY_PERMISSIONS, ALL_PERMISSIONS, ADMIN_ACCESS_COVERS, SCOPABLE,
  toList, withCarried, isTrueAdmin, hasPermission, isDenied, passesAdminGate,
} = require('../constants/permissions');

const NONE = () => ({ all: false, departmentIds: new Set() });
const ALL = () => ({ all: true, departmentIds: new Set() });

/** Stored grants as current names, each with the stored name it came from. */
const storedGrants = (user) => {
  const out = [];
  toList(user?.permissions).forEach((name) => {
    if (LEGACY_PERMISSIONS[name]) LEGACY_PERMISSIONS[name].forEach((p) => out.push({ cap: p, legacy: true }));
    else if (ALL_PERMISSIONS.includes(name)) out.push({ cap: name, legacy: false });
  });
  return out;
};

/**
 * The scope rows for ONE stored grant, as a scope. No rows → all staff.
 * rows: [{ capability, kind: 'own'|'department', departmentId }]
 */
const scopeOfRows = (rows, ownDepartmentId) => {
  if (!rows.length) return ALL();
  const ids = new Set();
  rows.forEach((r) => {
    if (r.kind === 'own') { if (ownDepartmentId) ids.add(Number(ownDepartmentId)); }
    else if (r.kind === 'department' && r.departmentId) ids.add(Number(r.departmentId));
  });
  return { all: false, departmentIds: ids };
};

const union = (a, b) => {
  if (a.all || b.all) return ALL();
  return { all: false, departmentIds: new Set([...a.departmentIds, ...b.departmentIds]) };
};

/**
 * This person's scope on `capability`.
 * @param user            the person (permissions/deniedPermissions/role as on req.user)
 * @param capability      e.g. 'leave.sick'
 * @param rows            ALL their PermissionScope rows (any capability)
 * @param ownDepartmentId their own StaffProfile.departmentId (or null)
 */
const resolveScope = ({ user, capability, rows = [], ownDepartmentId = null }) => {
  if (!user || !passesAdminGate(user, capability)) return NONE();
  if (!SCOPABLE.includes(capability)) return ALL();
  if (isTrueAdmin(user)) return ALL();
  if (hasPermission(user, PERMISSIONS.ADMIN_ACCESS) && ADMIN_ACCESS_COVERS.includes(capability)
      && !isDenied(user, capability)) return ALL();

  let scope = null;
  for (const g of storedGrants(user)) {
    if (!withCarried([g.cap]).has(capability)) continue;
    const own = g.legacy ? [] : rows.filter((r) => r.capability === g.cap);
    scope = scope ? union(scope, scopeOfRows(own, ownDepartmentId)) : scopeOfRows(own, ownDepartmentId);
    if (scope.all) return scope;
  }
  // Held, but not through any stored grant (a role or type default): all staff.
  return scope || ALL();
};

/**
 * Could stored scope rows change this person's answer on `capability`? False
 * when it is "all staff" whatever is stored (true admin, full admin access, or
 * no directly ticked SCOPABLE grant yields it) — the service then skips the
 * database entirely, so unscoped people cost nothing.
 */
const mayBeScoped = (user, capability) => {
  if (!user || !SCOPABLE.includes(capability) || isTrueAdmin(user)) return false;
  if (hasPermission(user, PERMISSIONS.ADMIN_ACCESS) && ADMIN_ACCESS_COVERS.includes(capability)) return false;
  return storedGrants(user).some((g) => !g.legacy && SCOPABLE.includes(g.cap) && withCarried([g.cap]).has(capability));
};

/** Is a person in this department inside the scope? (No department → only ALL.) */
const inScope = (scope, departmentId) =>
  !!scope && (scope.all || (departmentId != null && scope.departmentIds.has(Number(departmentId))));

/** Is scope `inner` no wider than `outer`? (For a scoped HR grantor, L-8.) */
const withinScope = (inner, outer) => {
  if (outer.all) return true;
  if (inner.all) return false;
  return [...inner.departmentIds].every((id) => outer.departmentIds.has(id));
};

// ---- the shape the Permissions tab sends and shows ----
// { kind: 'all' } · { kind: 'own' } · { kind: 'departments', departmentIds: [..] }

/** A client-sent scope spec, cleaned; null if it makes no sense. */
const cleanSpec = (spec) => {
  if (!spec || typeof spec !== 'object') return null;
  if (spec.kind === 'all') return { kind: 'all' };
  if (spec.kind === 'own') return { kind: 'own' };
  if (spec.kind === 'departments') {
    const ids = [...new Set(toList(spec.departmentIds).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    return ids.length ? { kind: 'departments', departmentIds: ids } : null;
  }
  return null;
};

/** Stored rows for one capability → a spec. */
const specOfRows = (rows) => {
  if (!rows.length) return { kind: 'all' };
  if (rows.some((r) => r.kind === 'own')) return { kind: 'own' };
  return { kind: 'departments', departmentIds: rows.map((r) => Number(r.departmentId)).sort((a, b) => a - b) };
};

/** A spec → the rows to store (none for 'all'). */
const rowsOfSpec = (spec) => {
  if (!spec || spec.kind === 'all') return [];
  if (spec.kind === 'own') return [{ kind: 'own', departmentId: null }];
  return spec.departmentIds.map((id) => ({ kind: 'department', departmentId: id }));
};

const sameSpec = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A spec as a scope, for someone in `ownDepartmentId`. */
const scopeOfSpec = (spec, ownDepartmentId) =>
  scopeOfRows(rowsOfSpec(spec).map((r) => ({ ...r, capability: '_' })), ownDepartmentId);

module.exports = {
  NONE, ALL, resolveScope, mayBeScoped, inScope, withinScope, union,
  cleanSpec, specOfRows, rowsOfSpec, sameSpec, scopeOfSpec,
};
