// Inline HR permission checks for use INSIDE controllers (HR Suite, B21).
//
// authorize() at the route is the coarse gate. When a controller has to decide
// something finer — "your own rows, or everyone's?" — it needs the same answer
// authorize('admin', 'hr.view') would give, including the admin.access bypass
// and withdrawals. hasPermission() alone does NOT know about the bypass, so a
// doctor + admin.access (Emu) would be refused. One helper, used everywhere:
// passesAdminGate in constants/permissions.js is that answer, and these are
// its two HR spellings.
const { PERMISSIONS, passesAdminGate, canViewConfidential } = require('../constants/permissions');

// hasPermission already folds IMPLIED_BY / BUNDLES / legacy names in (a
// stored hr.write holds hr.view and hr.tags).
const canViewHr  = (user) => passesAdminGate(user, PERMISSIONS.HR_VIEW);
// Someone else's remembered phones (seeing and revoking them) sit with the
// entrance tags — both are how a person checks in. Was hr.write until HR Tier 3.
const canManageCheckinDevices = (user) => passesAdminGate(user, PERMISSIONS.HR_TAGS);

// Staff documents that are HEALTH DATA (B27 debt fix, 2 Oct 2026). A sick
// note is the document behind sick leave, so it follows the same rule as the
// sick-leave type itself (leaveService.PRIVATE_TYPES): only the person, a
// leave.sick holder (HR Tier 3; leave.manage carries it), or an
// hr.confidential holder may see it on the staff
// file. users.view alone — enough to open the rest of the Documents tab — is
// NOT enough. Approvers reach a leave's attachment through the leave route
// (GET /api/leave/requests/:id/attachment), not through the Documents tab.
// Add a category here and every staff-document read honours it.
const HEALTH_DOCUMENT_CATEGORIES = ['Sick Note'];
const isHealthDocument = (doc) => !!doc && HEALTH_DOCUMENT_CATEGORIES.includes(doc.category);
const canSeeHealthDocumentsOf = (user, staffUser) =>
  !!user && !!staffUser && (
    staffUser.id === user.id
    || canViewConfidential(user)
    || passesAdminGate(user, PERMISSIONS.LEAVE_SICK)
  );

module.exports = {
  canViewHr, canManageCheckinDevices,
  HEALTH_DOCUMENT_CATEGORIES, isHealthDocument, canSeeHealthDocumentsOf,
};
