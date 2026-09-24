// Inline HR permission checks for use INSIDE controllers (HR Suite, B21).
//
// authorize() at the route is the coarse gate. When a controller has to decide
// something finer — "your own rows, or everyone's?" — it needs the same answer
// authorize('admin', 'hr.view') would give, including the admin.access bypass
// and withdrawals. hasPermission() alone does NOT know about the bypass, so a
// doctor + admin.access (Emu) would be refused. One helper, used everywhere.
const { PERMISSIONS, hasPermission, isDenied, isTrueAdmin } = require('../constants/permissions');

const passes = (user, cap) =>
  !isDenied(user, cap)
  && (isTrueAdmin(user) || hasPermission(user, PERMISSIONS.ADMIN_ACCESS) || hasPermission(user, cap));

// hasPermission already folds IMPLIED_BY in (hr.write ⇒ hr.view).
const canViewHr  = (user) => passes(user, PERMISSIONS.HR_VIEW);
const canWriteHr = (user) => passes(user, PERMISSIONS.HR_WRITE);

module.exports = { canViewHr, canWriteHr };
