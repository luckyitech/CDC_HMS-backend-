// Inline HR permission checks for use INSIDE controllers (HR Suite, B21).
//
// authorize() at the route is the coarse gate. When a controller has to decide
// something finer — "your own rows, or everyone's?" — it needs the same answer
// authorize('admin', 'hr.view') would give, including the admin.access bypass
// and withdrawals. hasPermission() alone does NOT know about the bypass, so a
// doctor + admin.access (Emu) would be refused. One helper, used everywhere:
// passesAdminGate in constants/permissions.js is that answer, and these are
// its two HR spellings.
const { PERMISSIONS, passesAdminGate } = require('../constants/permissions');

// hasPermission already folds IMPLIED_BY in (hr.write ⇒ hr.view).
const canViewHr  = (user) => passesAdminGate(user, PERMISSIONS.HR_VIEW);
const canWriteHr = (user) => passesAdminGate(user, PERMISSIONS.HR_WRITE);

module.exports = { canViewHr, canWriteHr };
