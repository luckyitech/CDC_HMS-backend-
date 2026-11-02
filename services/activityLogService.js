// Roles whose logins are tracked in the activity log.
//
// Nurse and admin were missing, so neither appeared in the activity log or on
// the Activity tab of their staff file — it looked like they had never logged
// in. Patients are still excluded: they are not staff, and their portal is a
// different trust boundary.
//
// Must stay in step with the role ENUM on UserLoginLog. A role listed here but
// absent from the enum is silently dropped, because the insert below is
// fire-and-forget.
const TRACKED_ROLES = new Set(['staff', 'doctor', 'lab', 'nurse', 'admin']);

// The sign-in record itself is written by services/signinLog.js recordSignin
// (16 Oct 2026), which reads this set.

module.exports = { TRACKED_ROLES };
