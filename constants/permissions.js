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

const PERMISSIONS = {
  // Reach the admin portal and every endpoint gated by authorize('admin').
  ADMIN_ACCESS: 'admin.access',
  // Manage the stock module. Replaces the canManageStock boolean.
  STOCK_MANAGE: 'stock.manage',
  // Run the billing desk: raise and issue invoices, take payments, reverse
  // them, and maintain the price list. Reception's capability.
  BILLING_MANAGE: 'billing.manage',
  // See prices OUTSIDE the billing screens — on the doctor's charge list, on a
  // patient's profile. Split from BILLING_MANAGE because the clinic may want a
  // doctor who can quote a patient a price without being able to bill anyone,
  // and because clinical staff are money-blind by default.
  BILLING_VIEW_PRICES: 'billing.viewPrices',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Permissions that confer others.
//
// Whoever runs the billing desk obviously sees prices, and granting them
// separately every time would be a footgun: the day someone forgets, reception
// gets a checkout screen with no figures on it. Expanded in
// effectivePermissions, so a single grant cannot drift out of step with what it
// is supposed to include.
const IMPLIED_PERMISSIONS = {
  [PERMISSIONS.BILLING_MANAGE]: [PERMISSIONS.BILLING_VIEW_PRICES],
};

// Roles that may hold permissions at all. Patients are excluded outright: the
// patient portal is a different trust boundary, and no capability here makes
// sense for someone who is a subject of the records rather than a user of them.
const PERMISSIBLE_ROLES = ['doctor', 'staff', 'lab'];

/**
 * Everything a user can do, as a Set.
 *
 * A real admin implicitly holds every permission — that is what the role means,
 * and storing the list on the admin row would just be a second thing to keep in
 * sync. Anyone else holds exactly what has been granted.
 */
const effectivePermissions = (user) => {
  if (!user) return new Set();
  if (user.role === 'admin') return new Set(ALL_PERMISSIONS);

  const granted = Array.isArray(user.permissions) ? user.permissions : [];
  const effective = new Set(granted);
  granted.forEach((permission) => {
    (IMPLIED_PERMISSIONS[permission] || []).forEach((implied) => effective.add(implied));
  });
  return effective;
};

const hasPermission = (user, permission) => effectivePermissions(user).has(permission);

/** A real admin account, as opposed to someone granted admin capabilities. */
const isTrueAdmin = (user) => user?.role === 'admin';

/**
 * Normalise a permissions list coming from a client: unknown names dropped,
 * duplicates removed, order stable. Returning only known permissions means a
 * typo silently grants nothing rather than storing a string that looks like a
 * permission and is never checked.
 */
const sanitizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  return ALL_PERMISSIONS.filter((p) => input.includes(p));
};

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  IMPLIED_PERMISSIONS,
  PERMISSIBLE_ROLES,
  effectivePermissions,
  hasPermission,
  isTrueAdmin,
  sanitizePermissions,
};
