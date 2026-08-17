// =====================================================================
// Role sets shared across route files.
//
// `role` is identity (see constants/permissions.js). These are the recurring
// *groups* of roles that route gates keep spelling out by hand — and getting
// out of step: when 'nurse' was added as a role, only the newest routes knew
// about it, so a nurse opening the unified Patient File got 403 on assessments,
// exams, plans, prescriptions, consultation notes and every GLP-1 read (the
// frontend .catch()es hid it, so the file just looked empty), and could not
// record an injection, write a week note or record use from the Nursing tab.
//
// One list, one place. Add a role here and every gate that spreads it follows.
// =====================================================================

// Roles whose portals carry the unified Patient File (RECORD-FILES.md) and may
// therefore READ every clinical record that Visit History and the Diagnostics /
// Medical Equipment tabs show. Reads only — writes stay per-route.
const RECORD_READERS = ['doctor', 'nurse', 'staff', 'admin'];

module.exports = { RECORD_READERS };
