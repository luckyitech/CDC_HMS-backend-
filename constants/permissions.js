// =====================================================================
// Per-user permissions — capabilities granted on top of a user's role.
//
// A permission does NOT change who someone is. A nurse granted ADMIN_ACCESS is
// still role 'staff': they keep their StaffProfile, their staff portal and
// their identity, and gain the admin portal as well. That separation is what
// keeps this cheap — profile loading, portal routing and the five-portal model
// are untouched.
//
// Adding a capability later costs a string here, not a migration: permissions
// live in one JSON column and are checked through one middleware. This replaced
// the previous approach of a dedicated boolean column plus a bespoke middleware
// per capability (canManageStock / authorizeStock), which cost a schema change
// every time and had already started to duplicate logic.
//
// Roles are NOT permissions. `role` stays the source of truth for identity, and
// two things are deliberately reserved to a real role: 'admin' account:
//   - granting or revoking permissions
//   - anything else that could make a grant irrevocable
// See middleware/auth.js and controllers/userController.js.
// =====================================================================

// Capabilities are named <section>.<verb>. A section that has meaningful write
// actions carries both '.access' (reach it, read it) and '.write' (act in it);
// a section that is all-or-nothing carries only '.access'. A write toggle is
// NOT added where it would mean nothing — the same rule the project applies to
// audit fields.
const PERMISSIONS = {
  // Reach the admin portal and every endpoint gated by authorize('admin').
  // All-or-nothing by nature: "everything an administrator can do" has no
  // coherent read-only half, so there is deliberately no admin.write.
  ADMIN_ACCESS: 'admin.access',

  // Stock / Pharmacy. Split from the old all-or-nothing 'stock.manage' so a
  // person can be given visibility (levels, batches, movements, reports)
  // without the ability to move the ledger.
  STOCK_ACCESS: 'stock.access',
  STOCK_WRITE:  'stock.write',

  // Reach the inpatient module (ward board + inpatient records) regardless of
  // role. Doctors and nurses reach it by role; this opens it to a granted user
  // (e.g. staff). Grantable from the Staff File's Permissions tab.
  INPATIENT_ACCESS: 'inpatient.access',
  // Act on an admission: convert / direct admit, transfer, discharge, cancel a
  // request, release a bed, add an inpatient charge. Deliberately NOT the
  // doctor-authored clinical record (ward round notes, discharge summary,
  // radiology and medication orders) — authoring a clinical entry is clinical
  // authority, not module access, and stays gated by role.
  INPATIENT_WRITE: 'inpatient.write',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Superseded capability names, mapped to what they mean now. Kept so a row
// written before the stock split still resolves to the right access after
// deploy — including in environments brought up by sequelize.sync() rather
// than by running the migration. Nothing new should ever be added here.
const LEGACY_PERMISSIONS = {
  'stock.manage': [PERMISSIONS.STOCK_ACCESS, PERMISSIONS.STOCK_WRITE],
};

// Granting a write implies the access it is meaningless without, so the two can
// never be stored in a state the UI cannot represent.
const IMPLIED_BY = {
  [PERMISSIONS.STOCK_WRITE]:     PERMISSIONS.STOCK_ACCESS,
  [PERMISSIONS.INPATIENT_WRITE]: PERMISSIONS.INPATIENT_ACCESS,
};

/**
 * The portal sections the Staff File's Permissions tab renders, in order.
 *
 * Lives here rather than in the frontend so the tab cannot drift from what the
 * routes actually enforce: the catalog endpoint serves this shape, and the tab
 * renders whatever it is given.
 */
const PERMISSION_SECTIONS = [
  {
    key: 'admin',
    name: 'Admin portal',
    description: 'User management, clinical catalog, ward config, monitoring and settings.',
    access: PERMISSIONS.ADMIN_ACCESS,
    write: null,
    // What the ROLE already allows, in plain words. Without it the tab cannot
    // say whether granting or withdrawing is the meaningful action for this
    // person — "no toggle set" means something different in each section.
    roleDefault: 'Administrators only',
    accessLabel: 'Can access',
    warning: 'They will be able to do everything an administrator can, except grant permissions to others.',
  },
  {
    key: 'stock',
    name: 'Stock / Pharmacy',
    description: 'Stock levels, batches, movements and reports.',
    access: PERMISSIONS.STOCK_ACCESS,
    write: PERMISSIONS.STOCK_WRITE,
    roleDefault: 'Nobody by role — must be granted',
    accessLabel: 'Can view',
    writeLabel: 'Can receive, dispense, transfer and adjust',
  },
  {
    key: 'inpatient',
    name: 'Inpatient',
    description: 'Ward board, admissions and the inpatient record.',
    access: PERMISSIONS.INPATIENT_ACCESS,
    write: PERMISSIONS.INPATIENT_WRITE,
    roleDefault: 'Clinical and front-desk roles',
    accessLabel: 'Can view',
    writeLabel: 'Can admit, transfer, discharge and bill',
  },
];

// Roles that may hold permissions at all. Patients are excluded outright: the
// patient portal is a different trust boundary, and no capability here makes
// sense for someone who is a subject of the records rather than a user of them.
const PERMISSIBLE_ROLES = ['doctor', 'staff', 'lab', 'nurse'];

// Every internal role. Read access to a patient's record is not restricted by
// cadre: anyone who works here and is looking at a patient file sees the whole
// file. Writes are NOT covered by this — each route keeps its own, narrower
// list for POST/PUT/DELETE, so who may *record* a clinical entry is unchanged.
//
// 'patient' is deliberately absent. The patient portal is a different trust
// boundary: a patient is the subject of these records, not a user of them, and
// doctors' notes are written on the understanding that patients do not read
// them. Routes that intentionally expose a patient's own data to them keep
// 'patient' listed explicitly alongside this spread.
const CLINICAL_READ_ROLES = ['doctor', 'staff', 'nurse', 'lab', 'admin'];

/** A real admin account, as opposed to someone granted admin capabilities. */
const isTrueAdmin = (user) => user?.role === 'admin';

/**
 * A stored list of capability strings, as a Set of current names: legacy names
 * expanded to what they mean now, unknown names dropped.
 */
const expand = (list) => {
  const out = new Set();
  (Array.isArray(list) ? list : []).forEach((name) => {
    if (LEGACY_PERMISSIONS[name]) LEGACY_PERMISSIONS[name].forEach((p) => out.add(p));
    else if (ALL_PERMISSIONS.includes(name)) out.add(name);
  });
  return out;
};

/**
 * Capabilities explicitly WITHDRAWN from this user — the restrictive half of
 * the model. A grant adds to what a role allows; a denial subtracts from it,
 * so an admin can hold one person out of a section their role would otherwise
 * open.
 *
 * A real admin account can never be denied anything. Allowing it would let an
 * administrator lock themselves — or the last remaining administrator — out of
 * the screen that grants permissions, with no way back in through the UI.
 */
const deniedPermissions = (user) => {
  if (!user || isTrueAdmin(user)) return new Set();
  return expand(user.deniedPermissions);
};

/**
 * Everything a user can do, as a Set.
 *
 * A real admin implicitly holds every permission — that is what the role means,
 * and storing the list on the admin row would just be a second thing to keep in
 * sync. Anyone else holds what has been granted, minus what has been withdrawn:
 * a denial beats a grant, so revoking is never ambiguous.
 */
const effectivePermissions = (user) => {
  if (!user) return new Set();
  if (isTrueAdmin(user)) return new Set(ALL_PERMISSIONS);
  const granted = expand(user.permissions);
  deniedPermissions(user).forEach((p) => granted.delete(p));
  return granted;
};

const hasPermission = (user, permission) => effectivePermissions(user).has(permission);

/** Has this capability been explicitly withdrawn from this user? */
const isDenied = (user, permission) => deniedPermissions(user).has(permission);

/**
 * Normalise a capability list coming from a client: legacy names translated,
 * unknown names dropped, duplicates removed, order stable. Returning only known
 * permissions means a typo silently grants nothing rather than storing a string
 * that looks like a permission and is never checked.
 */
const sanitizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const set = expand(input);
  // A write is meaningless without the access it acts within, so granting one
  // carries the other. Without this the tab could store "can dispense but
  // cannot open Stock", which no screen can represent and no gate expects.
  Object.entries(IMPLIED_BY).forEach(([write, access]) => {
    if (set.has(write)) set.add(access);
  });
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

/**
 * Normalise a denial list. Same rules, with the implication inverted:
 * withdrawing a section's access necessarily withdraws the ability to act in
 * it, or a denied user would still reach the write routes.
 */
const sanitizeDeniedPermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const set = expand(input);
  Object.entries(IMPLIED_BY).forEach(([write, access]) => {
    if (set.has(access)) set.add(write);
  });
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  LEGACY_PERMISSIONS,
  PERMISSION_SECTIONS,
  PERMISSIBLE_ROLES,
  CLINICAL_READ_ROLES,
  effectivePermissions,
  deniedPermissions,
  hasPermission,
  isDenied,
  isTrueAdmin,
  sanitizePermissions,
  sanitizeDeniedPermissions,
};
