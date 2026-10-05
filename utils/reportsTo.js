// "Reports to" (line manager) — the PURE rule (5 Oct 2026, HR fixes #1).
//
// StaffProfile.reportsToId is read by leave (the line manager is pre-added as
// an approver) and appraisals (the default reviewer). It is set from the staff
// file's Employment card and onboarding wizard step 2; both go through
// services/reportsTo.resolveReportsTo, which loads the rows and calls this.
//
// Owner decision: the manager may be ANY active staff member (not only someone
// inside the editor's department — a nurse's manager often sits elsewhere),
// never the person themselves, and never a choice that closes a loop
// (A reports to B reports to A).

const { STAFF_ROLES } = require('../constants/staffRoles');

// Longest chain walked before giving up — far deeper than any real clinic.
const MAX_HOPS = 50;

/**
 * '' / null / undefined → null (clears); a positive integer → that number;
 * anything else → NaN (refused as INVALID).
 */
const normaliseReportsTo = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

/**
 * Pure. Returns null when allowed, or { code, message }.
 *
 *   personId   the staff member being edited (null for a new person)
 *   managerId  the normalised choice (null clears — always allowed)
 *   manager    { id, role, isActive, archived } or null when no such user
 *   managerOf  Map userId → reportsToId for everyone (used to find a loop)
 */
const reportsToProblem = ({ personId, managerId, manager, managerOf = new Map() }) => {
  if (managerId === null) return null;
  if (Number.isNaN(managerId)) return { code: 'INVALID', message: 'Choose a staff member as the line manager' };
  if (personId && Number(managerId) === Number(personId)) {
    return { code: 'SELF', message: 'Someone cannot report to themselves' };
  }
  if (!manager || !STAFF_ROLES.includes(manager.role) || !manager.isActive || manager.archived) {
    return { code: 'NOT_ACTIVE_STAFF', message: 'The line manager must be an active member of staff' };
  }
  if (personId) {
    let at = managerOf.get(Number(managerId));
    for (let hops = 0; at && hops < MAX_HOPS; hops += 1) {
      if (Number(at) === Number(personId)) {
        return { code: 'CYCLE', message: 'That would make a loop — this person is already above the chosen manager' };
      }
      at = managerOf.get(Number(at));
    }
  }
  return null;
};

/**
 * Naming YOURSELF as someone's line manager (review S6). "Reports to" makes
 * you their leave approver and the default reviewer of their next appraisal,
 * so a staff.edit holder may not pick themselves — unless they are the true
 * admin or run appraisals (hr.appraisals.run), who may choose reviewers anyway.
 * Pure: null when allowed, or { code, message }.
 */
const namingYourselfProblem = ({ callerId, managerId, callerMayNameSelf }) => {
  if (!callerId || managerId === null || Number.isNaN(managerId)) return null;
  if (Number(managerId) !== Number(callerId) || callerMayNameSelf) return null;
  return {
    code: 'NAMING_YOURSELF',
    message: 'You can\'t make yourself someone\'s line manager — it would make you their leave approver and appraisal reviewer. Ask HR (whoever runs appraisals) to set it.',
  };
};

module.exports = { normaliseReportsTo, reportsToProblem, namingYourselfProblem, MAX_HOPS };
