// =====================================================================
// Per-user permissions — capabilities granted on top of a user's role.
//
// A permission does NOT change who someone is. A doctor granted ADMIN_ACCESS is
// still role 'doctor': they keep their StaffProfile, their portal and their
// identity, and gain the admin portal as well. That separation is what keeps
// this cheap — profile loading, portal routing and the portal model are
// untouched.
//
// Adding a capability later costs a string here, not a migration: permissions
// live in one JSON column and are checked through one middleware. This replaced
// the previous approach of a dedicated boolean column plus a bespoke middleware
// per capability (canManageStock / authorizeStock), which cost a schema change
// every time and had already started to duplicate logic.
//
// Roles are NOT permissions. `role` stays the source of truth for identity, and
// two things are deliberately reserved to a real 'admin' account:
//   - granting or revoking permissions
//   - anything else that could make a grant irrevocable
// See middleware/auth.js and controllers/userController.js.
//
// ---------------------------------------------------------------------
// TWO KINDS OF CAPABILITY
//
// portal.*  — which portal SHELL a person may enter. Frontend only: a portal is
//             a set of screens, not an API concept, so the server has no portal
//             to check against. Every endpoint behind those screens is still
//             gated by the functional capabilities below, which is where the
//             actual boundary lives.
//
// <area>.*  — what a person may DO. These are global: holding 'queue.write'
//             means holding it wherever the queue appears. They are deliberately
//             NOT scoped per portal — the server only ever sees a token, never a
//             portal, so a per-portal right could not be enforced and would be a
//             boundary in appearance only.
//
// An area with meaningful write actions carries both '.view'/'.access' and
// '.write'; an all-or-nothing area carries one. A write toggle is NOT added
// where it would mean nothing — the same rule the project applies to audit
// fields.
// =====================================================================

const PERMISSIONS = {
  // --- Portal entry (see note above: frontend shell only) ---
  PORTAL_ADMIN:     'portal.admin',
  PORTAL_DOCTOR:    'portal.doctor',
  PORTAL_STAFF:     'portal.staff',
  PORTAL_LAB:       'portal.lab',
  PORTAL_INPATIENT: 'portal.inpatient',
  PORTAL_RADIOLOGY: 'portal.radiology',

  // --- Administration ---
  // Passes any endpoint gated by authorize('admin'). Kept as the broad grant it
  // has always been; the three below carve out narrower slices for someone who
  // should run one admin screen without holding the lot.
  ADMIN_ACCESS:    'admin.access',
  USERS_VIEW:      'users.view',
  USERS_WRITE:     'users.write',
  CONFIG_WRITE:    'config.write',
  MONITORING_VIEW: 'monitoring.view',

  // --- Patient administration ---
  PATIENTS_WRITE:     'patients.write',
  QUEUE_WRITE:        'queue.write',
  APPOINTMENTS_VIEW:  'appointments.view',
  APPOINTMENTS_WRITE: 'appointments.write',
  DOCUMENTS_WRITE:    'documents.write',

  // --- Modules ---
  // Reach the inpatient module (ward board + inpatient records) regardless of
  // role. Doctors reach it by role; this opens it to a granted user.
  INPATIENT_ACCESS: 'inpatient.access',
  // Act on an admission: convert / direct admit, transfer, discharge, cancel a
  // request, release a bed, add an inpatient charge. Deliberately NOT the
  // doctor-authored clinical record (ward round notes, discharge summary,
  // radiology and medication orders) — authoring a clinical entry is clinical
  // authority, not module access, and stays gated by role.
  INPATIENT_WRITE: 'inpatient.write',

  // Stock / Pharmacy. Split from the old all-or-nothing 'stock.manage' so a
  // person can be given visibility without the ability to move the ledger.
  STOCK_ACCESS: 'stock.access',
  STOCK_WRITE:  'stock.write',

  // Lab results. LAB_WRITE is entering and amending results; ordering a test
  // stays with the doctor role, since ordering is a clinical decision.
  LAB_VIEW:  'lab.view',
  LAB_WRITE: 'lab.write',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Superseded capability names, mapped to what they mean now. Kept so a row
// written before the stock split still resolves to the right access after
// deploy — including in environments brought up by sequelize.sync() rather
// than by running the migration. Nothing new should ever be added here.
const LEGACY_PERMISSIONS = {
  'stock.manage': [PERMISSIONS.STOCK_ACCESS, PERMISSIONS.STOCK_WRITE],
};

// Granting a capability implies the one it is meaningless without, so the two
// can never be stored in a state the UI cannot represent.
//
// PORTAL_ADMIN deliberately does NOT imply ADMIN_ACCESS. It used to, on the
// reasoning that an admin portal you cannot use is pointless — but that was only
// true before the narrow admin capabilities existed. With users.view,
// config.write and monitoring.view available, an admin portal holding just one
// of them is a perfectly useful thing to grant, and the implication made it
// impossible to express: opening the portal quietly handed over every
// administrator power. Full administrator access is its own toggle now, and
// granting it is a separate, deliberate act.
const IMPLIED_BY = {
  [PERMISSIONS.STOCK_WRITE]:        PERMISSIONS.STOCK_ACCESS,
  [PERMISSIONS.INPATIENT_WRITE]:    PERMISSIONS.INPATIENT_ACCESS,
  [PERMISSIONS.LAB_WRITE]:          PERMISSIONS.LAB_VIEW,
  [PERMISSIONS.USERS_WRITE]:        PERMISSIONS.USERS_VIEW,
  [PERMISSIONS.APPOINTMENTS_WRITE]: PERMISSIONS.APPOINTMENTS_VIEW,
};

// Which portals each role reaches without anything being granted.
//
// A LIST per role, not one "home" portal. The single-portal version was wrong:
// a doctor has always reached both their own portal and the inpatient
// workspace, so mapping doctor -> portal.doctor alone silently shut doctors out
// of the ward. The Radiology Suite has the same shape — doctors and front desk
// both reach it by role — which is what made the assumption visible.
//
// Grants add to this list and withdrawals subtract from it, so a portal here is
// a default rather than a guarantee.
const ROLE_DEFAULT_PORTALS = {
  admin:  [PERMISSIONS.PORTAL_ADMIN],   // a real admin short-circuits below anyway
  doctor: [PERMISSIONS.PORTAL_DOCTOR, PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.PORTAL_RADIOLOGY],
  staff:  [PERMISSIONS.PORTAL_STAFF,  PERMISSIONS.PORTAL_RADIOLOGY],
  lab:    [PERMISSIONS.PORTAL_LAB],
  nurse:  [PERMISSIONS.PORTAL_INPATIENT],
};

/**
 * The Permissions tab, in render order.
 *
 * Lives here rather than in the frontend so the tab cannot drift from the
 * vocabulary the routes enforce: the catalog endpoint serves this shape and the
 * tab renders whatever it is given.
 *
 * Areas are grouped by what they ARE, not by which portal shows them. Several
 * appear in more than one portal, and because a capability is global, nesting
 * them under portals would suggest a per-portal setting that does not exist —
 * `appliesIn` names the portals instead.
 */
const PERMISSION_GROUPS = [
  {
    key: 'portals',
    name: 'Portals',
    description: 'Which parts of the system this person can open. Their own role always '
      + 'opens their own portal.',
    areas: [
      { key: 'p-admin',     name: 'Admin portal',        access: PERMISSIONS.PORTAL_ADMIN,     accessLabel: 'Can open', roleDefault: 'Administrators',
        warning: 'This opens the admin portal. What they can actually do inside it is set by the Administration group below — on its own, this grants no administrator powers.' },
      { key: 'p-doctor',    name: 'Doctor portal',       access: PERMISSIONS.PORTAL_DOCTOR,    accessLabel: 'Can open', roleDefault: 'Doctors' },
      { key: 'p-staff',     name: 'Staff portal',        access: PERMISSIONS.PORTAL_STAFF,     accessLabel: 'Can open', roleDefault: 'Front desk' },
      { key: 'p-lab',       name: 'Lab portal',          access: PERMISSIONS.PORTAL_LAB,       accessLabel: 'Can open', roleDefault: 'Lab technicians' },
      { key: 'p-inpatient', name: 'Inpatient workspace', access: PERMISSIONS.PORTAL_INPATIENT, accessLabel: 'Can open', roleDefault: 'Doctors and nurses' },
      { key: 'p-radiology', name: 'Radiology Suite',    access: PERMISSIONS.PORTAL_RADIOLOGY, accessLabel: 'Can open', roleDefault: 'Doctors and front desk' },
    ],
  },
  {
    key: 'patient-admin',
    name: 'Patient administration',
    description: 'Day-to-day front-desk work. Reading a patient record is not listed here — '
      + 'that follows the clinical role rules and is not set per person.',
    areas: [
      { key: 'patients', name: 'Patient records', appliesIn: 'Staff, Doctor, Admin',
        description: 'Registering a patient and editing their details.',
        access: null, write: PERMISSIONS.PATIENTS_WRITE,
        writeLabel: 'Can register and edit patients', roleDefault: 'Front desk, doctors' },
      { key: 'queue', name: 'Queue and triage', appliesIn: 'Staff, Doctor',
        access: null, write: PERMISSIONS.QUEUE_WRITE,
        writeLabel: 'Can move patients through the queue', roleDefault: 'Front desk, doctors' },
      { key: 'appointments', name: 'Appointments', appliesIn: 'Staff, Doctor, Admin',
        access: PERMISSIONS.APPOINTMENTS_VIEW, write: PERMISSIONS.APPOINTMENTS_WRITE,
        accessLabel: 'Can view the diary', writeLabel: 'Can book, reschedule and cancel',
        roleDefault: 'Front desk, doctors' },
      { key: 'documents', name: 'Medical documents', appliesIn: 'Staff, Doctor, Admin',
        access: null, write: PERMISSIONS.DOCUMENTS_WRITE,
        writeLabel: 'Can upload and edit documents', roleDefault: 'Front desk, doctors' },
    ],
  },
  {
    key: 'modules',
    name: 'Modules',
    areas: [
      { key: 'inpatient', name: 'Inpatient', appliesIn: 'Inpatient workspace, Staff, Doctor',
        description: 'Ward board, admissions and the inpatient record.',
        access: PERMISSIONS.INPATIENT_ACCESS, write: PERMISSIONS.INPATIENT_WRITE,
        accessLabel: 'Can view', writeLabel: 'Can admit, transfer, discharge and bill',
        roleDefault: 'Clinical and front-desk roles' },
      { key: 'stock', name: 'Stock / Pharmacy', appliesIn: 'Staff, Doctor, Admin',
        description: 'Stock levels, batches, movements and reports.',
        access: PERMISSIONS.STOCK_ACCESS, write: PERMISSIONS.STOCK_WRITE,
        accessLabel: 'Can view', writeLabel: 'Can receive, dispense, transfer and adjust',
        roleDefault: 'Nobody by role — must be granted' },
      { key: 'lab', name: 'Lab results', appliesIn: 'Lab, Doctor',
        description: 'Pending tests, results, history and critical alerts. Ordering a test '
          + 'stays with the doctor role.',
        access: PERMISSIONS.LAB_VIEW, write: PERMISSIONS.LAB_WRITE,
        accessLabel: 'Can view results', writeLabel: 'Can enter and amend results',
        roleDefault: 'Lab technicians, doctors' },
    ],
  },
  {
    key: 'administration',
    name: 'Administration',
    description: 'Slices of the admin portal, for someone who should run one screen without '
      + 'holding everything an administrator can do.',
    areas: [
      { key: 'admin-all', name: 'Full administrator access', appliesIn: 'Admin',
        description: 'Every admin-only endpoint, including the three below. Anything set to '
          + 'Withdrawn still overrides this — a withdrawal always beats a grant.',
        // Marks a grant broad enough that a withdrawal elsewhere carves a hole in
        // it. The tab spells out the exceptions rather than leaving the card
        // claiming "everything" while something below is switched off.
        broad: true,
        access: PERMISSIONS.ADMIN_ACCESS, accessLabel: 'Can do everything an admin can',
        roleDefault: 'Administrators',
        warning: 'They will be able to do everything an administrator can, except grant permissions to others.' },
      { key: 'users', name: 'Users and staff files', appliesIn: 'Admin',
        access: PERMISSIONS.USERS_VIEW, write: PERMISSIONS.USERS_WRITE,
        accessLabel: 'Can view users', writeLabel: 'Can create and edit users',
        roleDefault: 'Administrators' },
      { key: 'config', name: 'Catalog, wards and settings', appliesIn: 'Admin',
        access: null, write: PERMISSIONS.CONFIG_WRITE,
        writeLabel: 'Can change clinical catalog, wards and system settings',
        roleDefault: 'Administrators' },
      { key: 'monitoring', name: 'Monitoring and analytics', appliesIn: 'Admin',
        access: PERMISSIONS.MONITORING_VIEW, accessLabel: 'Can view activity log, analytics and reports',
        roleDefault: 'Administrators' },
    ],
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
 * A JSON-array column, as a real array.
 *
 * Sequelize hands a JSON column back already parsed on MySQL, but as a raw
 * string on some drivers and on MariaDB (where JSON is longtext plus a
 * json_valid() CHECK). Treating a string as "not an array" would silently
 * resolve to NO capabilities — every check failing closed, the user locked out
 * of everything, and nothing logged. Tolerating both shapes costs one branch.
 */
const toList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

/**
 * A stored list of capability strings, as a Set of current names: legacy names
 * expanded to what they mean now, unknown names dropped.
 */
const expand = (list) => {
  const out = new Set();
  toList(list).forEach((name) => {
    if (LEGACY_PERMISSIONS[name]) LEGACY_PERMISSIONS[name].forEach((p) => out.add(p));
    else if (ALL_PERMISSIONS.includes(name)) out.add(name);
  });
  return out;
};

/**
 * Capabilities explicitly WITHDRAWN from this user — the restrictive half of
 * the model. A grant adds to what a role allows; a denial subtracts from it,
 * so an admin can hold one person out of an area their role would otherwise
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
 * May this user open this portal shell?
 *
 * Their own role's portal always, plus anything granted, minus anything
 * withdrawn. Shared with the frontend through the session payload so
 * ProtectedRoute and this agree on one answer.
 */
const canOpenPortal = (user, portalPermission) => {
  if (!user) return false;
  if (isTrueAdmin(user)) return true;
  if (isDenied(user, portalPermission)) return false;
  if ((ROLE_DEFAULT_PORTALS[user.role] || []).includes(portalPermission)) return true;
  // Full administrator access carries the door with it. The reverse implication
  // was removed (see IMPLIED_BY), but this direction still holds: every admin
  // power and no way to reach the portal would be the same trap mirrored.
  if (portalPermission === PERMISSIONS.PORTAL_ADMIN
      && hasPermission(user, PERMISSIONS.ADMIN_ACCESS)) return true;
  return hasPermission(user, portalPermission);
};

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
  Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
    if (set.has(held)) set.add(implied);
  });
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

/**
 * Normalise a denial list. Same rules, with the implication inverted:
 * withdrawing an area's access necessarily withdraws the ability to act in it,
 * or a denied user would still reach the write routes.
 */
const sanitizeDeniedPermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const set = expand(input);
  Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
    if (set.has(implied)) set.add(held);
  });
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

module.exports = {
  PERMISSIONS,
  toList,
  ALL_PERMISSIONS,
  LEGACY_PERMISSIONS,
  PERMISSION_GROUPS,
  ROLE_DEFAULT_PORTALS,
  PERMISSIBLE_ROLES,
  CLINICAL_READ_ROLES,
  effectivePermissions,
  deniedPermissions,
  hasPermission,
  isDenied,
  canOpenPortal,
  isTrueAdmin,
  sanitizePermissions,
  sanitizeDeniedPermissions,
};
