// Delegated HR granting — the PURE rule (HR Tier 3 Phase 0, decisions
// P-2/P-5/P-6; moved here from staffController in Phase 3 so the Permissions
// tab and the onboarding wizard (O-1: an HR grantor ticks HR controls while
// onboarding) apply exactly the same check).

const {
  PERMISSIONS, hasPermission, isTrueAdmin, canGrantPermissions, HR_DELEGABLE, HR_NOT_DELEGABLE, passesAdminGate,
} = require('../constants/permissions');

/**
 * What a "Grant HR permissions" holder (who is NOT a permissions
 * administrator) may change — HR Tier 3 Phase 0, decisions P-2/P-5/P-6.
 * Pure: returns null when allowed, or { message, code } when refused.
 *
 *   - never their own file;
 *   - never someone who is themselves a permissions administrator, a true
 *     admin or holds full administrator access (that is the key-holder's call);
 *   - never the staff type (clinical access is not an HR control);
 *   - every capability whose granted/withdrawn state changes must be an HR
 *     control (HR_DELEGABLE — never hr.confidential or hr.grant), and anything
 *     GIVEN (granted, or a withdrawal lifted) one the caller could exercise
 *     themselves.
 */
const hrGrantRefusal = ({ caller, target, before, after }) => {
  if (target.id === caller.id) {
    return { message: 'You cannot change your own permissions', code: 403 };
  }
  if (isTrueAdmin(target) || canGrantPermissions(target) || hasPermission(target, PERMISSIONS.ADMIN_ACCESS)) {
    return { message: 'Only a permissions administrator can change this person\'s access', code: 403 };
  }
  if (after.staffType !== before.staffType) {
    return { message: 'Only a permissions administrator can change whether someone is clinical', code: 403 };
  }
  const flip = (a, b) => [...a.filter((p) => !b.includes(p)), ...b.filter((p) => !a.includes(p))];
  const changed = [...new Set([
    ...flip(before.permissions, after.permissions),
    ...flip(before.deniedPermissions, after.deniedPermissions),
  ])];
  const outside = changed.filter((p) => !HR_DELEGABLE.includes(p) || HR_NOT_DELEGABLE.includes(p));
  if (outside.length) {
    return { message: 'You can only change HR Suite permissions', code: 403, extra: { code: 'NOT_DELEGABLE', capabilities: outside } };
  }
  // "Only what you can do yourself" applies to GIVING: a new grant, or lifting
  // a withdrawal. Taking an HR control away is allowed whether or not the
  // caller holds it (an HR officer may hold someone back from sick details).
  const given = [
    ...after.permissions.filter((p) => !before.permissions.includes(p)),
    ...before.deniedPermissions.filter((p) => !after.deniedPermissions.includes(p)),
  ];
  const notHeld = given.filter((p) => !passesAdminGate(caller, p));
  if (notHeld.length) {
    return { message: 'You can only give or take away what you can do yourself', code: 403, extra: { code: 'NOT_HELD', capabilities: notHeld } };
  }
  return null;
};

module.exports = { hrGrantRefusal };
