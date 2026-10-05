// Delegated HR granting — the PURE rule (HR Tier 3 Phase 0, decisions
// P-2/P-5/P-6; moved here from staffController in Phase 3 so the Permissions
// tab and the onboarding wizard (O-1: an HR grantor ticks HR controls while
// onboarding) apply exactly the same check).

const {
  PERMISSIONS, hasPermission, isTrueAdmin, canGrantPermissions, HR_DELEGABLE, HR_NOT_DELEGABLE, passesAdminGate,
  canGrantHrPermissions, canEditPermissions, canViewConfidential, canReadAppraisals, reconcilePermissionLists, toList,
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

/**
 * Does `user` hold `cap` the way that control's own gate decides? The two
 * explicit-grant controls (hr.confidential, hr.appraisals) are NOT carried by
 * admin.access, and the two grant keys have their own tests.
 */
const holdsControl = (user, cap) => {
  if (cap === PERMISSIONS.HR_CONFIDENTIAL) return canViewConfidential(user);
  if (cap === PERMISSIONS.HR_APPRAISALS) return canReadAppraisals(user);
  if (cap === PERMISSIONS.PERMISSIONS_GRANT) return canGrantPermissions(user);
  if (cap === PERMISSIONS.HR_GRANT) return canGrantHrPermissions(user);
  return passesAdminGate(user, cap);
};

// Accounts whose login email only a permissions editor may change: whoever
// could read or grant what most needs protecting (5 Oct 2026, review S2).
const PROTECTED_CONTROLS = [
  PERMISSIONS.ADMIN_ACCESS, PERMISSIONS.PERMISSIONS_GRANT, PERMISSIONS.HR_GRANT,
  PERMISSIONS.HR_CONFIDENTIAL, PERMISSIONS.HR_APPRAISALS, PERMISSIONS.USERS_WRITE,
];
const isAccessHolder = (user) => isTrueAdmin(user) || PROTECTED_CONTROLS.some((c) => holdsControl(user, c));

/**
 * May `caller` change `target`'s LOGIN email? (5 Oct 2026, HR fixes #16 and
 * review S2.) The password-reset link goes to whatever email is stored, so
 * changing it is an account-takeover path. ONE rule for both endpoints
 * (PUT /api/staff/:employeeId and PUT /api/users/:id). Pure: null when
 * allowed, or { message, code, extra }.
 *
 *   1. only someone who passes the Manage Users write gate (users.write);
 *   2. never someone who holds more than the caller: every control GRANTED to
 *      the target (their stored grants — role defaults are not grants) must be
 *      one the caller holds, and only the true admin may change the true
 *      admin's;
 *   3. never a protected account — a true admin, or a holder of admin.access,
 *      permissions.grant, hr.grant, hr.confidential, hr.appraisals or
 *      users.write — unless the caller is a true admin or can edit
 *      permissions; an HR grantor (hr.grant, not a permissions administrator)
 *      is then held to the Permissions-tab rule (hrGrantRefusal: never
 *      yourself, never an administrator) and never a peer HR grantor.
 */
const loginEmailRefusal = ({ caller, target }) => {
  if (!passesAdminGate(caller, PERMISSIONS.USERS_WRITE)) {
    return { message: 'Only someone who manages login accounts (Manage Users) can change a login email', code: 403, extra: { code: 'LOGIN_EMAIL_NOT_ALLOWED' } };
  }
  if (isTrueAdmin(caller)) return null;
  const protectedMsg = { message: 'Only a permissions administrator can change the login email of someone who holds administrator, permission-granting or confidential access', code: 403, extra: { code: 'LOGIN_EMAIL_PROTECTED' } };
  if (isTrueAdmin(target)) return protectedMsg;
  const targetGrants = reconcilePermissionLists(toList(target.permissions), toList(target.deniedPermissions)).granted;
  const lacking = targetGrants.filter((c) => !holdsControl(caller, c));
  if (lacking.length) {
    return { message: 'You can only change the login email of someone whose access you hold yourself', code: 403, extra: { code: 'LOGIN_EMAIL_HOLDS_MORE', capabilities: lacking } };
  }
  if (!isAccessHolder(target) || canGrantPermissions(caller)) return null;
  if (canEditPermissions(caller)) {
    const same = { permissions: [], deniedPermissions: [], staffType: target.staffType };
    const refused = hrGrantRefusal({ caller, target, before: same, after: same });
    if (!refused && !holdsControl(target, PERMISSIONS.HR_GRANT)) return null;
  }
  return protectedMsg;
};

/**
 * May a "Grant HR permissions" holder (NOT a permissions administrator) apply
 * this preset to an existing account? (5 Oct 2026, HR fixes #22.) Only when
 * EVERY control in it is one they may grant: an HR control (HR_DELEGABLE, never
 * hr.confidential / hr.grant), and — for what it grants — one they hold
 * themselves. Pure: null when allowed, or { message, code, extra }. The usual
 * Permissions-tab rules (hrGrantRefusal, scope reach) still run on the result.
 */
const presetApplyRefusal = ({ caller, granted = [], denied = [] }) => {
  const notHr = [...granted, ...denied].filter((p) => !HR_DELEGABLE.includes(p) || HR_NOT_DELEGABLE.includes(p));
  if (notHr.length) {
    return { message: 'This preset includes controls outside the HR Suite — only a permissions administrator can apply it', code: 403, extra: { code: 'PRESET_NOT_DELEGABLE', capabilities: [...new Set(notHr)] } };
  }
  const notHeld = granted.filter((p) => !passesAdminGate(caller, p));
  if (notHeld.length) {
    return { message: 'This preset gives controls you do not hold yourself — only someone who holds them, or a permissions administrator, can apply it', code: 403, extra: { code: 'PRESET_NOT_HELD', capabilities: notHeld } };
  }
  return null;
};

/** The login-email rule alone; the staff file adds its own edit gate (staffController.fileExtras). */
const canChangeLoginEmail = (caller, target) => !loginEmailRefusal({ caller, target });

module.exports = { hrGrantRefusal, loginEmailRefusal, canChangeLoginEmail, presetApplyRefusal };
