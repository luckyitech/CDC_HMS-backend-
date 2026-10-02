const { error } = require('../utils/response');
const { canActOnAny } = require('../services/hrScope');

// Department scope on a staff-file route (HR Tier 3 Phase 1, L-5). Runs AFTER
// authorize() (the coarse "may use this control at all") and findStaff (which
// puts the person on req.staffUser). If the caller's scope on every listed
// control leaves this person out, the file simply isn't there for them:
// "Staff member not found" (404), the same answer as an unknown employee id —
// never "access denied", which would confirm the person exists.
const inStaffScope = (...capabilities) => async (req, res, next) => {
  try {
    if (await canActOnAny(req.user, capabilities, req.staffUser.id)) return next();
    return error(res, 'Staff member not found', 404);
  } catch (err) {
    console.error('inStaffScope error:', err);
    return error(res, 'Failed to load staff member', 500);
  }
};

module.exports = { inStaffScope };
