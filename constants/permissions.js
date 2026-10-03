// =====================================================================
// Per-user permissions — capabilities granted on top of a user's role.
//
// A permission does NOT change who someone is. A doctor granted ADMIN_ACCESS is
// still role 'doctor': they keep their StaffProfile, their portal and their
// identity, and gain the admin portal as well. That separation is what keeps
// this cheap — profile loading, portal routing and the portal model are
// untouched.
//
// Adding a capability later costs a string here, not a migration: permissions
// live in one JSON column and are checked through one middleware. This replaced
// the previous approach of a dedicated boolean column plus a bespoke middleware
// per capability (canManageStock / authorizeStock), which cost a schema change
// every time and had already started to duplicate logic.
//
// Roles are NOT permissions. `role` stays the source of truth for identity, and
// two things are deliberately reserved to a real 'admin' account:
//   - granting or revoking permissions
//   - anything else that could make a grant irrevocable
// See middleware/auth.js and controllers/userController.js.
//
// ---------------------------------------------------------------------
// TWO KINDS OF CAPABILITY
//
// portal.*  — which portal SHELL a person may enter. Frontend only: a portal is
//             a set of screens, not an API concept, so the server has no portal
//             to check against. Every endpoint behind those screens is still
//             gated by the functional capabilities below, which is where the
//             actual boundary lives.
//
// <area>.*  — what a person may DO. These are global: holding 'queue.write'
//             means holding it wherever the queue appears. They are deliberately
//             NOT scoped per portal — the server only ever sees a token, never a
//             portal, so a per-portal right could not be enforced and would be a
//             boundary in appearance only.
//
// An area with meaningful write actions carries both '.view'/'.access' and
// '.write'; an all-or-nothing area carries one. A write toggle is NOT added
// where it would mean nothing — the same rule the project applies to audit
// fields.
// =====================================================================

const PERMISSIONS = {
  // --- Portal entry (see note above: frontend shell only) ---
  PORTAL_ADMIN:     'portal.admin',
  PORTAL_DOCTOR:    'portal.doctor',
  PORTAL_STAFF:     'portal.staff',
  PORTAL_LAB:       'portal.lab',
  PORTAL_INPATIENT: 'portal.inpatient',
  PORTAL_RADIOLOGY: 'portal.radiology',
  // HR Suite — staff time & attendance (B21). Every internal role opens it by
  // default: the portal is where a member of staff sees their own record.
  PORTAL_HR:        'portal.hr',

  // --- Administration ---
  // Passes any endpoint gated by authorize('admin'). Kept as the broad grant it
  // has always been; the three below carve out narrower slices for someone who
  // should run one admin screen without holding the lot.
  ADMIN_ACCESS:    'admin.access',

  // Surgery on the patient record: merging two records into one, deleting a
  // patient, undoing a merge, and the duplicate list that finds them. Separate
  // from PATIENTS_WRITE, which is registering and editing — these are
  // irreversible and act on records rather than on a person's details.
  PATIENTS_MERGE:  'patients.merge',

  // Structural setup and maintenance: beds, retiring a catalog item, rebuilding
  // stock levels, archiving an ultrasound, removing a GLP-1 side-effect entry.
  // Configuration of the system rather than work done in it.
  //
  // Both of these exist so that ADMIN_ACCESS is exactly the sum of the boxes
  // shown beneath it. Ten admin-only routes had no capability at all, so they
  // appeared nowhere on the Permissions tab — which meant unticking any admin
  // sub-box and having the parent untick with it would silently remove ten
  // powers nothing on screen mentioned, with no way to give them back.
  ADMIN_SETUP:     'admin.setup',

  USERS_VIEW:      'users.view',
  USERS_WRITE:     'users.write',
  CONFIG_WRITE:    'config.write',
  MONITORING_VIEW: 'monitoring.view',

  // The right to grant and withdraw capabilities on OTHER people — the one
  // power that must not propagate. Deliberately NOT covered by ADMIN_ACCESS
  // (tests/permissionVocabulary.test.js enforces the exclusion): holding full
  // administrator access lets you run the clinic, not mint new administrators.
  // Cannot be self-granted. Seeded to a named account by migration
  // 20260923000009; the true 'admin' account remains a fallback holder.
  // Decision of record: claude/session-2026-09-24-permissions-grant-decision.md
  PERMISSIONS_GRANT: 'permissions.grant',

  // --- Patient administration ---
  PATIENTS_WRITE:     'patients.write',
  QUEUE_WRITE:        'queue.write',
  APPOINTMENTS_VIEW:  'appointments.view',
  APPOINTMENTS_WRITE: 'appointments.write',
  DOCUMENTS_WRITE:    'documents.write',

  // --- Modules ---
  // Reach the inpatient module (ward board + inpatient records) regardless of
  // role. Doctors reach it by role; this opens it to a granted user.
  INPATIENT_ACCESS: 'inpatient.access',
  // Act on an admission: convert / direct admit, transfer, discharge, cancel a
  // request, release a bed, add an inpatient charge. Deliberately NOT the
  // doctor-authored clinical record (ward round notes, discharge summary,
  // radiology and medication orders) — authoring a clinical entry is clinical
  // authority, not module access, and stays gated by role.
  INPATIENT_WRITE: 'inpatient.write',

  // Stock / Pharmacy. Split from the old all-or-nothing 'stock.manage' so a
  // person can be given visibility without the ability to move the ledger.
  STOCK_ACCESS: 'stock.access',
  STOCK_WRITE:  'stock.write',

  // Lab results. LAB_WRITE is entering and amending results; ordering a test
  // stays with the doctor role, since ordering is a clinical decision.
  LAB_VIEW:  'lab.view',
  LAB_WRITE: 'lab.write',

  // Lab Inbox — external lab-report PDFs pulled from the clinic mailbox and
  // paired to patients. VIEW is seeing the inbox and opening a staged PDF;
  // WRITE is pulling the mailbox, pairing a report (which files a
  // MedicalDocument as Pending Review) and discarding a wrong pull. Front desk
  // and the lab hold both by role; a doctor or nurse can be granted them.
  // Connecting the mailbox itself is system configuration (CONFIG_WRITE, and
  // a real admin for the credentials) — not part of this.
  LABINBOX_VIEW:  'labinbox.view',
  LABINBOX_WRITE: 'labinbox.write',

  // Communications Inbox — patient messages on the clinic's WhatsApp number
  // (and later Facebook / Instagram — the capability is channel-agnostic). VIEW
  // is reading threads and opening attachments; WRITE is replying, linking a
  // thread to a patient, filing an attachment, booking from chat, escalating
  // and setting reminders. Front desk, doctors and nurses hold both by role; a
  // lab technician can be granted them. Emailed/WhatsApped LAB reports are the
  // separate Lab Inbox capability above.
  COMMS_VIEW:  'comms.view',
  COMMS_WRITE: 'comms.write',

  // Staff Email (B26) — using one's OWN clinic mailbox inside the HMS (the My
  // mail tab of the Inbox): connect it, read, and (phase 2) send. Every
  // internal role holds it by role (the /api/mail gate lists them); withdraw it
  // to stop one person using mail in the HMS. It never reaches anyone else's
  // mailbox — there is no capability for that, by design (decision D1).
  EMAIL_USE: 'email.use',

  // Staff Email phase 5 — reading the TEXT of the emails on a patient's
  // Communications trail (their email threads: messages to the patient,
  // replies, and emails a colleague linked to the file). Doctors, nurses and
  // admins by role; anyone else (e.g. reception) by grant; withdrawable per
  // person. Without it the trail shows only that an email was sent.
  PATIENT_EMAIL_VIEW: 'patientemail.view',

  // --- Clinical ---
  // The clinical record itself, as opposed to the patient's identity and
  // administration. Reception legitimately needs to know who a patient is,
  // where they are in the queue, which ward they are on and what they owe; they
  // have no reason to read the consultation note. Before this existed there was
  // no way to say that, so every internal role read everything.
  //
  // CLINICAL_VIEW covers reading: consultation notes, treatment plans, nursing
  // notes, blood-sugar readings, discharge summaries.
  // CLINICAL_RECORD covers writing the everyday clinical entries a nurse makes:
  // vitals and nursing notes. Authoring a doctor's clinical record — the
  // consultation note, the treatment plan, a prescription, a diagnosis — is
  // clinical authority and stays gated by the doctor role, exactly as
  // INPATIENT_WRITE stops short of the ward round note.
  CLINICAL_VIEW:   'clinical.view',
  CLINICAL_RECORD: 'clinical.record',

  // GLP-1 therapy administration: recording a weekly injection, a review, a
  // week note. Starting or stopping a course stays with the doctor role — that
  // is a prescribing decision, and the route files already say so.
  GLP1_WRITE: 'glp1.write',

  // Patient equipment and CareLink partners. Issuing, replacing and retiring a
  // device, and maintaining the caregiver contacts attached to a patient.
  EQUIPMENT_WRITE: 'equipment.write',

  // Handing stock to or taking it back from a patient: point-of-care use,
  // checkout dispense at discharge, returns. Separate from STOCK_WRITE, which
  // is running the ledger — intake, transfers, adjustments, write-offs. The
  // route files had already reached for this distinction in comments
  // ("clinical/reception roles, NOT a stock capability") and had to settle for
  // naming roles because there was no capability to name.
  STOCK_DISPENSE: 'stock.dispense',

  // Writing to a patient's ultrasound imaging — currently saving a
  // clinician-edited still into their record.
  //
  // It covered the thyroid reporting tool as well until that was removed from
  // main; the gating went with the tool rather than being left behind pointing
  // at nothing. Deliberately NOT part of the clinical default bundle: which
  // member of staff works on imaging varies by clinic, so hardcoding it to a
  // role would bake one hospital's staffing into the schema.
  RADIOLOGY_WRITE: 'radiology.write',

  // Recording a drug round — that a patient was actually given their
  // medication. Off by default and granted per person, for the same reason as
  // RADIOLOGY_WRITE.
  MAR_ADMINISTER: 'mar.administer',

  // --- HR Suite (B21) ---
  // HR_CHECKIN is tapping the entrance tag, exchanging a remembered-phone token
  // and reading one's OWN attendance and stars — every internal role holds it
  // by role (the route gate lists the roles); withdrawing it stops one person
  // checking in without touching anything else. HR_VIEW is everyone's
  // attendance: who is in, flags, the register. HR_WRITE is amending a session,
  // a manual entry, working hours and entrance tags. Both default to the admin
  // role and are covered by admin.access, so the clinic can bench the true
  // admin account and run HR on admin.access (decision 5). Tag KEYS and the
  // settings still need config.write on top, like every other settings write.
  HR_CHECKIN: 'hr.checkin',
  HR_VIEW:    'hr.view',
  // hr.write was split (HR Tier 3 Phase 0, 2 Oct 2026) into the three below —
  // see LEGACY_PERMISSIONS, which keeps every stored hr.write grant working.
  HR_ATTENDANCE_AMEND: 'hr.attendance.amend',  // manual entries, amending a session
  HR_WORKHOURS:        'hr.workhours',         // setting someone's working hours
  HR_TAGS:             'hr.tags',              // naming, testing, retiring entrance tags

  // --- HR Suite phase 2: leave (B27, decision D8 — every HR function its own
  // capability so an HR manager or a supervisor can be given all or some).
  // All default to the admin role and are covered by admin.access.
  //   LEAVE_APPROVE  be a valid approver on someone's leave, and choose which
  //                  balance(s) the days come off (D7). Nobody ever decides
  //                  their own leave, whatever they hold.
  //   LEAVE_MANAGE   see everyone's leave, record leave on someone's behalf
  //                  (approved on the spot), cancel approved leave.
  //   LEAVE_POLICY   the yearly leave policy, public holidays and each
  //                  person's entitlement override. Implies LEAVE_MANAGE.
  //   HR_SETTINGS    HR Suite settings: check-in rules, entrance tag keys and
  //                  alert channels. Replaces config.write on those routes.
  //                  Tag keys are SECRETS — don't put this in a preset lightly.
  //   HR_SELF        (phase 2) one's OWN record: apply for leave, follow and
  //                  withdraw one's own requests (routes/hrSelf.js, /api/hr/me).
  //                  Every internal role holds it by role, like HR_CHECKIN, so
  //                  withdrawing it stops one person using self-service.
  //   HR_PROFILE_APPROVE (phase 4) decide colleagues' profile change requests
  //                  — name, National ID, date of birth, licence and
  //                  qualification details they may not edit themselves (D11).
  //   HR_CREDENTIALS (phase 5, D12) verify colleagues' CPD (confirming or
  //                  adjusting the points) and receive the clinic-wide licence
  //                  and document expiry alerts. Ships with its first route
  //                  (PATCH /api/hr/cpd/:id/verify) — a capability that gates
  //                  nothing is a toggle that lies (tests/permissionVocabulary).
  HR_SELF:       'hr.self',
  HR_PROFILE_APPROVE: 'hr.profile.approve',
  // hr.credentials was split (Tier 3 Phase 0) into CPD_VERIFY and
  // HR_EXPIRY_ALERTS — see LEGACY_PERMISSIONS.
  CPD_VERIFY:       'cpd.verify',
  HR_EXPIRY_ALERTS: 'hr.expiry.alerts',
  LEAVE_APPROVE: 'leave.approve',
  // LEAVE_MANAGE now means: record leave on someone's behalf and cancel
  // anyone's live request. It still CARRIES see-everyone's-leave, sick-leave
  // details, required approvers and the register (BUNDLES below), so nobody
  // who held it loses anything; each of those can now also be given alone.
  LEAVE_MANAGE:  'leave.manage',
  // LEAVE_POLICY now means: the yearly policy and the leave types. It carries
  // public holidays and individual entitlements (BUNDLES), and still implies
  // LEAVE_MANAGE (IMPLIED_BY), exactly as before.
  LEAVE_POLICY:  'leave.policy',
  LEAVE_VIEW:         'leave.view',          // who is away, when, how long; sick shown "Private"
  LEAVE_SICK:         'leave.sick',          // sick-leave type, reason and sick note (health data)
  LEAVE_REQUIRED:     'leave.required',      // set someone's required approvers
  LEAVE_REGISTER:     'leave.register',      // download the leave register (logged)
  LEAVE_HOLIDAYS:     'leave.holidays',      // public holidays + the Sunday rule
  LEAVE_ENTITLEMENTS: 'leave.entitlements',  // per-person entitlement overrides
  HR_SETTINGS:   'hr.settings',

  // --- HR Suite, Tier 3 Phase 0 (2 Oct 2026): the staff file, split out of
  // users.view / users.write so an HR department can share the work. Both old
  // capabilities CARRY these (BUNDLES), so nobody loses anything at deploy;
  // users.view / users.write themselves still gate the Manage Users screen.
  STAFF_VIEW:      'staff.view',       // the directory and opening a staff file
  STAFF_EDIT:      'staff.edit',       // personal and employment details, photo
  STAFF_ONBOARD:   'staff.onboard',    // creating a staff account (onboarding wizard)
  STAFF_STATUS:    'staff.status',     // suspend / resign / terminate, archive, restore
  STAFF_DOCUMENTS: 'staff.documents',  // upload, reclassify, archive someone else's documents

  // HR Tier 3 Phase 1 (2 Oct 2026): the clinic's Departments and Positions
  // lists, and the one-off tidy screen that maps today's free text onto them.
  // Clinic-wide (never department-scoped); covered by admin.access.
  HR_LISTS: 'hr.lists',

  // HR Tier 3 Phase 2 (2 Oct 2026, T3-3 / R-1): HR Suite → Reports — headcount
  // and movement, leave owed, expiries, CPD and punctuality, each downloadable
  // (every download logged). Department-scopable: a limited holder's figures
  // count only their people. Sick leave appears only as one total (R-3).
  HR_REPORTS: 'hr.reports',

  // HR Tier 3 Phase 3 (3 Oct 2026, T3-4 / O-6): onboarding checklists.
  //   HR_ONBOARDING           see, tick, start and close people's checklists
  //                           (department-scopable).
  //   HR_ONBOARDING_TEMPLATES edit the checklist template for each role
  //                           (clinic-wide).
  HR_ONBOARDING:           'hr.onboarding',
  HR_ONBOARDING_TEMPLATES: 'hr.onboarding.templates',

  // HR Tier 3 Phase 4 (3 Oct 2026, T3-8 / RO-2): the shift roster.
  //   HR_ROSTER         build, copy and publish a department's week; a
  //                     published shift becomes that person's expected hours
  //                     for the day (T3-5 a). Department-scopable.
  //   HR_ROSTER_SHIFTS  the clinic-wide list of shift types (clinic-wide).
  HR_ROSTER:        'hr.roster',
  HR_ROSTER_SHIFTS: 'hr.roster.shifts',

  // The right to change OTHER people's HR Suite capabilities, and only those
  // (HR_DELEGABLE). Like permissions.grant it is checked by a bespoke gate
  // (canGrantHrPermissions), never authorize(), so admin.access can never
  // satisfy it; it cannot be self-granted, a holder can never grant it on, and
  // it is never in a preset. Decisions P-2/P-5/P-6 (2 Oct 2026).
  HR_GRANT: 'hr.grant',

  // Confidential staff documents — a contract, an appraisal, a disciplinary
  // letter, anything on a staff file marked "Admin only", and the archived
  // files. Like PERMISSIONS_GRANT this is deliberately NOT covered by
  // admin.access (tests/permissionVocabulary.test.js enforces the exclusion)
  // and held by nobody by role: being an administrator runs the clinic; reading
  // a colleague's contract is a separate, explicitly granted trust. The true
  // 'admin' account remains a fallback holder, as for every capability. Seeded
  // to a named account by migration 20260923000010. Decision (Emu, 24 Sep 2026):
  // "even an admin cannot see confidential data if the gate is not checked".
  HR_CONFIDENTIAL: 'hr.confidential',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// Superseded capability names, mapped to what they mean now. Kept so a row
// written before the stock split still resolves to the right access after
// deploy — including in environments brought up by sequelize.sync() rather
// than by running the migration. Only a capability that has been split
// COMPLETELY (nothing left for the old name to mean) belongs here; one that
// keeps a meaning of its own and also carries narrower ones is a BUNDLE.
//
// hr.write and hr.credentials (HR Tier 3 Phase 0, 2 Oct 2026): every stored
// grant AND withdrawal of either expands to the parts, so a person who held
// hr.write holds all four after deploy, and one refused it is refused all four.
// The next save of their Permissions tab stores the parts instead.
const LEGACY_PERMISSIONS = {
  'stock.manage': [PERMISSIONS.STOCK_ACCESS, PERMISSIONS.STOCK_WRITE],
  'hr.write': [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND, PERMISSIONS.HR_WORKHOURS, PERMISSIONS.HR_TAGS],
  'hr.credentials': [PERMISSIONS.CPD_VERIFY, PERMISSIONS.HR_EXPIRY_ALERTS],
};

// A capability that keeps its own meaning AND carries narrower ones
// (HR Tier 3 Phase 0). Different from IMPLIED_BY, which is a dependency ("a
// write is meaningless without its read"): withdrawing a PART of a bundle
// leaves the bundle alone — "manages leave, but may not see sick-leave
// details" is the case this exists for — while withdrawing the BUNDLE
// withdraws every part, which is what a withdrawal of it always meant.
//
// Resolved when access is worked out (effectivePermissions /
// deniedPermissions), never written to a row: granting leave.manage stores
// leave.manage, and the parts follow it wherever it goes.
const BUNDLES = {
  [PERMISSIONS.USERS_VIEW]:   [PERMISSIONS.STAFF_VIEW],
  [PERMISSIONS.USERS_WRITE]:  [PERMISSIONS.STAFF_EDIT, PERMISSIONS.STAFF_ONBOARD,
    PERMISSIONS.STAFF_STATUS, PERMISSIONS.STAFF_DOCUMENTS],
  [PERMISSIONS.LEAVE_MANAGE]: [PERMISSIONS.LEAVE_VIEW, PERMISSIONS.LEAVE_SICK,
    PERMISSIONS.LEAVE_REQUIRED, PERMISSIONS.LEAVE_REGISTER],
  [PERMISSIONS.LEAVE_POLICY]: [PERMISSIONS.LEAVE_HOLIDAYS, PERMISSIONS.LEAVE_ENTITLEMENTS],
};

// Granting a capability implies the one it is meaningless without, so the two
// can never be stored in a state the UI cannot represent.
//
// PORTAL_ADMIN deliberately does NOT imply ADMIN_ACCESS. It used to, on the
// reasoning that an admin portal you cannot use is pointless — but that was only
// true before the narrow admin capabilities existed. With users.view,
// config.write and monitoring.view available, an admin portal holding just one
// of them is a perfectly useful thing to grant, and the implication made it
// impossible to express: opening the portal quietly handed over every
// administrator power. Full administrator access is its own toggle now, and
// granting it is a separate, deliberate act.
const IMPLIED_BY = {
  [PERMISSIONS.STOCK_WRITE]:        PERMISSIONS.STOCK_ACCESS,
  [PERMISSIONS.INPATIENT_WRITE]:    PERMISSIONS.INPATIENT_ACCESS,
  [PERMISSIONS.LAB_WRITE]:          PERMISSIONS.LAB_VIEW,
  [PERMISSIONS.LABINBOX_WRITE]:     PERMISSIONS.LABINBOX_VIEW,
  [PERMISSIONS.COMMS_WRITE]:        PERMISSIONS.COMMS_VIEW,
  [PERMISSIONS.USERS_WRITE]:        PERMISSIONS.USERS_VIEW,
  [PERMISSIONS.APPOINTMENTS_WRITE]: PERMISSIONS.APPOINTMENTS_VIEW,
  [PERMISSIONS.CLINICAL_RECORD]:    PERMISSIONS.CLINICAL_VIEW,
  [PERMISSIONS.LEAVE_POLICY]:       PERMISSIONS.LEAVE_MANAGE,
  // HR Tier 3 Phase 0: each acting capability needs the read it acts within.
  [PERMISSIONS.HR_ATTENDANCE_AMEND]: PERMISSIONS.HR_VIEW,
  [PERMISSIONS.HR_WORKHOURS]:        PERMISSIONS.HR_VIEW,
  [PERMISSIONS.STAFF_EDIT]:          PERMISSIONS.STAFF_VIEW,
  [PERMISSIONS.STAFF_STATUS]:        PERMISSIONS.STAFF_VIEW,
  [PERMISSIONS.STAFF_DOCUMENTS]:     PERMISSIONS.STAFF_VIEW,
  [PERMISSIONS.LEAVE_MANAGE]:        PERMISSIONS.LEAVE_VIEW,
  [PERMISSIONS.LEAVE_SICK]:          PERMISSIONS.LEAVE_VIEW,
  [PERMISSIONS.LEAVE_REQUIRED]:      PERMISSIONS.LEAVE_VIEW,
};

/**
 * A set of capabilities with every dependency (IMPLIED_BY) and every bundle
 * part (BUNDLES) added, repeated until nothing changes — leave.policy brings
 * leave.manage, which brings its parts, which bring leave.view. Pure; shared
 * by effectivePermissions() and the Permissions tab (served in the catalog).
 */
const withCarried = (input) => {
  const set = new Set(input);
  let grew = true;
  while (grew) {
    grew = false;
    for (const cap of [...set]) {
      const adds = [...(BUNDLES[cap] || []), ...(IMPLIED_BY[cap] ? [IMPLIED_BY[cap]] : [])];
      for (const a of adds) if (!set.has(a)) { set.add(a); grew = true; }
    }
  }
  return set;
};

/** A denial set with each withdrawn bundle's parts withdrawn too. */
const withBundleDenials = (input) => {
  const set = new Set(input);
  let grew = true;
  while (grew) {
    grew = false;
    for (const cap of [...set]) {
      for (const a of (BUNDLES[cap] || [])) if (!set.has(a)) { set.add(a); grew = true; }
    }
  }
  return set;
};

// Which portals each role reaches without anything being granted.
//
// A LIST per role, not one "home" portal. The single-portal version was wrong:
// a doctor has always reached both their own portal and the inpatient
// workspace, so mapping doctor -> portal.doctor alone silently shut doctors out
// of the ward. The Radiology Suite has the same shape — doctors and front desk
// both reach it by role — which is what made the assumption visible.
//
// Grants add to this list and withdrawals subtract from it, so a portal here is
// a default rather than a guarantee.
//
// PORTAL_HR is on every entry: the HR Suite is where each member of staff sees
// their own attendance, so it is a default for everyone who works here, and is
// taken away per person by withdrawal like any other portal.
const ROLE_DEFAULT_PORTALS = {
  admin:  [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.PORTAL_HR],   // a real admin short-circuits below anyway
  doctor: [PERMISSIONS.PORTAL_DOCTOR, PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.PORTAL_RADIOLOGY, PERMISSIONS.PORTAL_HR],
  staff:  [PERMISSIONS.PORTAL_STAFF,  PERMISSIONS.PORTAL_RADIOLOGY, PERMISSIONS.PORTAL_HR],
  lab:    [PERMISSIONS.PORTAL_LAB, PERMISSIONS.PORTAL_HR],
  nurse:  [PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.PORTAL_HR],
};

// Every role that belongs to the clinic, as opposed to a patient. This is an
// INTERNAL-vs-patient list, not a clinical one.
//
// It was called CLINICAL_READ_ROLES, which was misleading from the day it was
// written — it contains every internal role, including reception — and became
// actively dangerous once `clinical` started to mean something specific. A gate
// wanting "any member of staff" uses this; a gate wanting "someone who does
// clinical work" uses PERMISSIONS.CLINICAL_VIEW.
const INTERNAL_ROLES = ['doctor', 'staff', 'nurse', 'lab', 'admin'];

// Deprecated alias. Kept so the rename can move file by file with the tests
// green at every step rather than in one flag-day commit. Remove once no route
// file imports it.
const CLINICAL_READ_ROLES = INTERNAL_ROLES;

// =====================================================================
// CLINICAL vs NON-CLINICAL
//
// `role` says which portal a person lands in. It does NOT say whether they
// touch patients — and 'staff' in particular is a leftover bin holding
// receptionists, administration and nurses together, so all of them held
// identical powers. Splitting that bin is what these two values are for.
//
// The two axes are independent on purpose. A clinic's nurse may be role
// 'staff'; its lab technician is role 'lab' and clinical; its administrator is
// role 'staff' and not. Folding the two together would just recreate the bin.
//
// Where the line falls: identity and administration on one side — who the
// patient is, where they are in the queue, which ward, what they owe — and the
// clinical record on the other. Reception cannot check anyone in without the
// first; it has no reason for the second.
// =====================================================================
const STAFF_TYPES = {
  CLINICAL:     'clinical',
  NON_CLINICAL: 'non_clinical',
};

/**
 * Does this account belong to the clinic, as opposed to a patient?
 *
 * The one thing a staff type must never be read for is a patient. Everything
 * below derives from the role rather than from the presence of a column, so a
 * patient row cannot acquire staff capabilities by carrying a stray value.
 */
const isInternal = (user) => !!user && INTERNAL_ROLES.includes(user.role);

// What each type holds without anything being ticked, so that a correctly
// created account is right before an admin ever opens the Permissions tab.
//
// This is the point of the whole feature. If the tab were the only mechanism,
// every new hire would be twenty ticks; nobody does twenty ticks, so the admin
// copies whatever the last person had and within a year everyone holds
// everything — which is precisely the state this is fixing. Defaults do the
// normal case; the tab handles exceptions.
//
// RADIOLOGY_WRITE and MAR_ADMINISTER are deliberately absent: which member of
// staff signs a scan or runs a drug round differs between clinics, so they are
// granted per person rather than assumed.
//
// PORTAL_INPATIENT is also absent, though every nurse needs it. staffType is
// independent of role, so a clinical bundle also covers doctors and the lab
// technician — and a lab technician does not belong on the ward. It is granted
// per person instead.
const TYPE_DEFAULT_PERMISSIONS = {
  [STAFF_TYPES.CLINICAL]: [
    PERMISSIONS.CLINICAL_VIEW,
    PERMISSIONS.CLINICAL_RECORD,
    PERMISSIONS.GLP1_WRITE,
    PERMISSIONS.EQUIPMENT_WRITE,
    PERMISSIONS.STOCK_DISPENSE,
  ],
  [STAFF_TYPES.NON_CLINICAL]: [],
};

// Roles that do hands-on patient care.
//
// A lab technician is clinical — they handle specimens and results, and they
// could always read a patient's clinical record for context. But they do not
// take vitals, write nursing notes, give GLP-1 injections or fit equipment, and
// before this branch the gates on all of those named 'doctor', 'staff' and
// 'nurse' and never 'lab'.
//
// Without this, marking the lab technician clinical would hand them the whole
// bundle and quietly WIDEN their access — the opposite of what this branch is
// for. The rule throughout is that capabilities are appended to gates so nobody
// loses anything; a default that silently grants somebody something new breaks
// that just as badly in the other direction.
const PATIENT_CARE_ROLES = ['doctor', 'staff', 'nurse'];

// What holding ADMIN_ACCESS effectively gives you.
//
// authorize() admits an admin.access holder to any gate that lists 'admin', so
// holding it silently confers every capability named alongside 'admin' anywhere
// in the route files. That is not a design choice made here — it is a
// consequence of the bypass, and it has always been true.
//
// It is written down because the Permissions tab has to be able to say so. A
// screen showing "Can view users" unticked for someone who can, in fact, view
// users is lying, and the admin then ticks it and watches nothing change.
//
// DERIVED, NOT INVENTED: permissionVocabulary.test.js recomputes this by
// scanning the routes and fails if the list drifts. Do not hand-edit it to make
// a test pass — if the test disagrees, the routes changed and this list is the
// thing that is wrong.
const ADMIN_ACCESS_COVERS = [
  PERMISSIONS.ADMIN_SETUP,
  PERMISSIONS.APPOINTMENTS_VIEW,
  PERMISSIONS.APPOINTMENTS_WRITE,
  PERMISSIONS.CLINICAL_RECORD,
  PERMISSIONS.CLINICAL_VIEW,
  PERMISSIONS.COMMS_VIEW,
  PERMISSIONS.COMMS_WRITE,
  PERMISSIONS.CONFIG_WRITE,
  PERMISSIONS.DOCUMENTS_WRITE,
  PERMISSIONS.EMAIL_USE,
  PERMISSIONS.HR_CHECKIN,
  PERMISSIONS.HR_VIEW,
  PERMISSIONS.HR_ATTENDANCE_AMEND,
  PERMISSIONS.HR_WORKHOURS,
  PERMISSIONS.HR_TAGS,
  PERMISSIONS.HR_SETTINGS,
  PERMISSIONS.HR_SELF,
  PERMISSIONS.HR_PROFILE_APPROVE,
  PERMISSIONS.CPD_VERIFY,
  PERMISSIONS.HR_EXPIRY_ALERTS,
  PERMISSIONS.LEAVE_VIEW,
  PERMISSIONS.LEAVE_SICK,
  PERMISSIONS.LEAVE_REQUIRED,
  PERMISSIONS.LEAVE_REGISTER,
  PERMISSIONS.LEAVE_HOLIDAYS,
  PERMISSIONS.LEAVE_ENTITLEMENTS,
  PERMISSIONS.STAFF_VIEW,
  PERMISSIONS.STAFF_EDIT,
  PERMISSIONS.STAFF_ONBOARD,
  PERMISSIONS.STAFF_STATUS,
  PERMISSIONS.STAFF_DOCUMENTS,
  PERMISSIONS.HR_LISTS,
  PERMISSIONS.HR_REPORTS,
  PERMISSIONS.HR_ONBOARDING,
  PERMISSIONS.HR_ONBOARDING_TEMPLATES,
  PERMISSIONS.HR_ROSTER,
  PERMISSIONS.HR_ROSTER_SHIFTS,
  PERMISSIONS.INPATIENT_ACCESS,
  PERMISSIONS.INPATIENT_WRITE,
  PERMISSIONS.LAB_VIEW,
  PERMISSIONS.LABINBOX_VIEW,
  PERMISSIONS.LABINBOX_WRITE,
  PERMISSIONS.LEAVE_APPROVE,
  PERMISSIONS.LEAVE_MANAGE,
  PERMISSIONS.LEAVE_POLICY,
  PERMISSIONS.MONITORING_VIEW,
  PERMISSIONS.PATIENT_EMAIL_VIEW,
  PERMISSIONS.PATIENTS_MERGE,
  PERMISSIONS.PATIENTS_WRITE,
  PERMISSIONS.QUEUE_WRITE,
  PERMISSIONS.RADIOLOGY_WRITE,
  PERMISSIONS.STOCK_DISPENSE,
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.USERS_WRITE,
];

/**
 * Does this person do clinical work?
 *
 * Defaults to clinical when unset. A row written before this column existed, or
 * a user with no StaffProfile, must not silently lose the clinical access they
 * have today — the split is applied by classifying people deliberately, never
 * by a missing value.
 */
const isClinical = (user) => isInternal(user) && user.staffType !== STAFF_TYPES.NON_CLINICAL;

/**
 * The capabilities a person holds by virtue of their staff type alone.
 *
 * A PATIENT never gets any of this, whatever their row says. The check is not
 * paranoia: staffType defaults to clinical so that no existing member of staff
 * loses access at deploy, and a patient row carries the same default — so
 * without this guard every patient would silently hold clinical.view and could
 * read the consultation notes of every patient in the clinic through the very
 * gate this branch added to stop that.
 *
 * The rule is that a staff type is meaningless for someone who is not staff.
 * Deriving it from the role rather than trusting the column keeps it that way
 * even if a patient row is later written with a staffType by some other path.
 */
const typeDefaultPermissions = (user) => {
  if (!isInternal(user)) return [];
  if (!isClinical(user)) return TYPE_DEFAULT_PERMISSIONS[STAFF_TYPES.NON_CLINICAL];
  // Clinical, but not a patient-care role: reading the clinical record only,
  // which is exactly what they could do before. See PATIENT_CARE_ROLES.
  if (!PATIENT_CARE_ROLES.includes(user.role)) return [PERMISSIONS.CLINICAL_VIEW];
  return TYPE_DEFAULT_PERMISSIONS[STAFF_TYPES.CLINICAL];
};

/**
 * The Permissions tab, in render order.
 *
 * Lives here rather than in the frontend so the tab cannot drift from the
 * vocabulary the routes enforce: the catalog endpoint serves this shape and the
 * tab renders whatever it is given.
 *
 * Areas are grouped by what they ARE, not by which portal shows them. Several
 * appear in more than one portal, and because a capability is global, nesting
 * them under portals would suggest a per-portal setting that does not exist —
 * `appliesIn` names the portals instead.
 */
const PERMISSION_GROUPS = [
  {
    key: 'portals',
    name: 'Portals',
    description: 'Which parts of the system this person can open. Their own role always '
      + 'opens their own portal.',
    areas: [
      { key: 'p-admin',     name: 'Admin portal',        access: PERMISSIONS.PORTAL_ADMIN,     accessLabel: 'Can open', roleDefault: 'Administrators',
        warning: 'This opens the admin portal. What they can actually do inside it is set by the Administration group below — on its own, this grants no administrator powers.' },
      { key: 'p-doctor',    name: 'Doctor portal',       access: PERMISSIONS.PORTAL_DOCTOR,    accessLabel: 'Can open', roleDefault: 'Doctors' },
      { key: 'p-staff',     name: 'Staff portal',        access: PERMISSIONS.PORTAL_STAFF,     accessLabel: 'Can open', roleDefault: 'Front desk' },
      { key: 'p-lab',       name: 'Lab portal',          access: PERMISSIONS.PORTAL_LAB,       accessLabel: 'Can open', roleDefault: 'Lab technicians' },
      { key: 'p-inpatient', name: 'Inpatient workspace', access: PERMISSIONS.PORTAL_INPATIENT, accessLabel: 'Can open', roleDefault: 'Doctors and nurses' },
      { key: 'p-radiology', name: 'Radiology Suite',    access: PERMISSIONS.PORTAL_RADIOLOGY, accessLabel: 'Can open', roleDefault: 'Doctors and front desk' },
      { key: 'p-hr',        name: 'HR Suite',           access: PERMISSIONS.PORTAL_HR,        accessLabel: 'Can open', roleDefault: 'Everyone' },
    ],
  },
  {
    key: 'patient-admin',
    name: 'Patient administration',
    description: 'Day-to-day front-desk work. Reading a patient record is not listed here — '
      + 'that follows the clinical role rules and is not set per person.',
    areas: [
      { key: 'patients', name: 'Patient records', appliesIn: 'Staff, Doctor, Admin',
        description: 'Registering a patient and editing their details.',
        access: null, write: PERMISSIONS.PATIENTS_WRITE,
        writeLabel: 'Can register and edit patients', roleDefault: 'Front desk, doctors' },
      { key: 'queue', name: 'Queue and triage', appliesIn: 'Staff, Doctor',
        access: null, write: PERMISSIONS.QUEUE_WRITE,
        writeLabel: 'Can move patients through the queue', roleDefault: 'Front desk, doctors' },
      { key: 'appointments', name: 'Appointments', appliesIn: 'Staff, Doctor, Admin',
        access: PERMISSIONS.APPOINTMENTS_VIEW, write: PERMISSIONS.APPOINTMENTS_WRITE,
        accessLabel: 'Can view the diary', writeLabel: 'Can book, reschedule and cancel',
        roleDefault: 'Front desk, doctors' },
      { key: 'documents', name: 'Medical documents', appliesIn: 'Staff, Doctor, Admin',
        access: null, write: PERMISSIONS.DOCUMENTS_WRITE,
        writeLabel: 'Can upload and edit documents', roleDefault: 'Front desk, doctors' },
    ],
  },
  {
    key: 'clinical',
    name: 'Clinical work',
    description: 'What this person may do with the clinical record, as opposed to the '
      + 'patient\'s identity and administration. Most of this follows from whether they are '
      + 'marked clinical or non-clinical on the Profile tab — set it there, and only use '
      + 'these when someone is an exception.',
    areas: [
      { key: 'clinical-record', name: 'Clinical record', appliesIn: 'Staff, Doctor, Inpatient workspace',
        description: 'Consultation notes, treatment plans, nursing notes and blood-sugar '
          + 'readings. Writing covers vitals and nursing notes; authoring a consultation '
          + 'note, treatment plan or prescription stays with the doctor role.',
        access: PERMISSIONS.CLINICAL_VIEW, write: PERMISSIONS.CLINICAL_RECORD,
        accessLabel: 'Can read the clinical record',
        writeLabel: 'Can record vitals and nursing notes',
        roleDefault: 'Clinical staff' },
      { key: 'glp1', name: 'GLP-1 therapy', appliesIn: 'Staff, Doctor',
        description: 'Recording weekly injections, reviews and week notes. Starting or '
          + 'stopping a course stays with the doctor role.',
        access: null, write: PERMISSIONS.GLP1_WRITE, readVia: PERMISSIONS.CLINICAL_VIEW,
        writeLabel: 'Can record injections and reviews', roleDefault: 'Clinical staff' },
      { key: 'equipment', name: 'Patient equipment', appliesIn: 'Staff, Doctor',
        description: 'Issuing, replacing and retiring a device, and the CareLink caregiver '
          + 'contacts attached to a patient.',
        access: null, write: PERMISSIONS.EQUIPMENT_WRITE, readVia: PERMISSIONS.CLINICAL_VIEW,
        writeLabel: 'Can issue and replace equipment', roleDefault: 'Clinical staff' },
      { key: 'dispensing', name: 'Dispensing to patients', appliesIn: 'Staff, Doctor',
        description: 'Point-of-care use, checkout dispense at discharge and returns. '
          + 'Separate from Stock / Pharmacy below, which is running the ledger.',
        access: null, write: PERMISSIONS.STOCK_DISPENSE,
        readOpen: 'the dispensing screens read the stock catalogue and a batch\'s return '
          + 'history, which is not patient-clinical data and stays open to every internal role',
        writeLabel: 'Can dispense to and take back from patients',
        roleDefault: 'Clinical staff' },
      { key: 'radiology-report', name: 'Radiology & neuropathy', appliesIn: 'Radiology Suite',
        description: 'Saving a clinician-edited ultrasound still, and recording/grading a '
          + 'neuropathy (PNS) study, into a patient\'s record.',
        access: null, write: PERMISSIONS.RADIOLOGY_WRITE,
        readOpen: 'reading a study follows the Radiology Suite portal and is unchanged by '
          + 'the clinical split',
        writeLabel: 'Can sign ultrasound & neuropathy studies',
        roleDefault: 'Nobody by role — must be granted' },
      { key: 'mar', name: 'Drug round', appliesIn: 'Inpatient workspace',
        description: 'Recording that a patient was given their medication. Ordering a '
          + 'medication stays with the doctor role.',
        access: null, write: PERMISSIONS.MAR_ADMINISTER, readVia: PERMISSIONS.INPATIENT_ACCESS,
        writeLabel: 'Can record medication administration',
        roleDefault: 'Nobody by role — must be granted' },
    ],
  },
  {
    key: 'modules',
    name: 'Modules',
    areas: [
      { key: 'inpatient', name: 'Inpatient', appliesIn: 'Inpatient workspace, Staff, Doctor',
        description: 'Ward board, admissions and the inpatient record.',
        access: PERMISSIONS.INPATIENT_ACCESS, write: PERMISSIONS.INPATIENT_WRITE,
        accessLabel: 'Can view', writeLabel: 'Can admit, transfer, discharge and bill',
        roleDefault: 'Clinical and front-desk roles' },
      { key: 'stock', name: 'Stock / Pharmacy', appliesIn: 'Staff, Doctor, Admin',
        description: 'Stock levels, batches, movements and reports.',
        access: PERMISSIONS.STOCK_ACCESS, write: PERMISSIONS.STOCK_WRITE,
        accessLabel: 'Can view', writeLabel: 'Can receive, dispense, transfer and adjust',
        roleDefault: 'Nobody by role — must be granted' },
      { key: 'lab', name: 'Lab results', appliesIn: 'Lab, Doctor',
        description: 'Pending tests, results, history and critical alerts. Ordering a test '
          + 'stays with the doctor role.',
        access: PERMISSIONS.LAB_VIEW, write: PERMISSIONS.LAB_WRITE,
        accessLabel: 'Can view results', writeLabel: 'Can enter and amend results',
        roleDefault: 'Lab technicians, doctors' },
      { key: 'lab-inbox', name: 'Lab Inbox (emailed lab reports)', appliesIn: 'Staff, Lab, Doctor',
        description: 'External lab reports pulled from the clinic mailbox, waiting to be '
          + 'paired to a patient. Pairing files the report into the patient\'s Diagnostics '
          + 'as Pending Review. Connecting the mailbox itself is under "Catalog, wards and '
          + 'settings" below.',
        access: PERMISSIONS.LABINBOX_VIEW, write: PERMISSIONS.LABINBOX_WRITE,
        accessLabel: 'Can view the inbox and open reports',
        writeLabel: 'Can pull the mailbox, pair and discard reports',
        roleDefault: 'Front desk, lab technicians' },
      { key: 'comms-inbox', name: 'Inbox (WhatsApp & social messages)', appliesIn: 'Staff, Doctor, Nurse, Lab',
        description: 'Patient messages on the clinic\'s WhatsApp number (and later Facebook / '
          + 'Instagram): read threads, reply, link to a patient, file attachments, book from '
          + 'chat, escalate, set reminders. Lab reports emailed or WhatsApped by labs are the '
          + 'separate "Lab Inbox" capability.',
        access: PERMISSIONS.COMMS_VIEW, write: PERMISSIONS.COMMS_WRITE,
        accessLabel: 'Can read conversations and open attachments',
        writeLabel: 'Can reply, link, file, book, escalate and set reminders',
        roleDefault: 'Front desk, doctors, nurses' },
      { key: 'staff-email', name: 'My mail (own clinic mailbox)', appliesIn: 'Inbox, every portal',
        description: 'Connecting their own clinic email and reading it in the HMS. Only ever '
          + 'their own mailbox — nobody, administrators included, can open another person\'s '
          + 'mail through the HMS. Withdraw it to stop one person using email here.',
        access: PERMISSIONS.EMAIL_USE, accessLabel: 'Can use their own mailbox in the HMS',
        roleDefault: 'Everyone' },
      { key: 'patient-email', name: 'Patient email threads', appliesIn: 'Patient file → Communications',
        description: 'Reading the text of the emails on a patient\'s Communications tab: messages '
          + 'sent to the patient, their replies, and emails a colleague linked to the file (e.g. an '
          + 'insurer pre-authorisation). Without it the tab shows only that an email was sent.',
        access: PERMISSIONS.PATIENT_EMAIL_VIEW, accessLabel: 'Can read patient email threads',
        roleDefault: 'Doctors, nurses' },
    ],
  },
  // ---- HR Suite: seven groups (HR Tier 3 Phase 0, 2 Oct 2026) ----
  // `hr: true` marks the groups an "Grant HR permissions" (hr.grant) holder may
  // edit on someone else's file — HR_DELEGABLE is derived from it. Each area
  // is ONE capability: an HR department shares the work by holding different
  // ones. Department limits on these arrive with the Departments list (Phase 1).
  {
    key: 'hr-self',
    hr: true,
    name: 'HR Suite · Self-service',
    description: 'What every member of staff does for themselves. Withdraw one to stop a '
      + 'single person using it.',
    areas: [
      { key: 'hr-self', name: 'My profile and My leave', appliesIn: 'HR Suite → My profile, My leave',
        description: 'Their own record: applying for leave, following a request, answering an '
          + 'approver, asking HR to change a detail, logging CPD.',
        access: PERMISSIONS.HR_SELF, accessLabel: 'Can use their own profile and leave',
        roleDefault: 'Everyone' },
      { key: 'hr-checkin', name: 'Check in and out', appliesIn: 'HR Suite, entrance tag',
        description: 'Tapping the entrance tag, remembering a phone, and seeing their own '
          + 'attendance and stars.',
        access: PERMISSIONS.HR_CHECKIN, accessLabel: 'Can check in and out and see their own record',
        roleDefault: 'Everyone' },
    ],
  },
  {
    key: 'hr-people',
    hr: true,
    name: 'HR Suite · People and staff files',
    description: 'Other people\'s staff files. "Users and staff files" under Administration '
      + 'still carries all of these.',
    areas: [
      { key: 'staff-view', name: 'Open staff files', appliesIn: 'HR Suite → Staff, staff files',
        description: 'The staff directory and every tab of a staff file they are allowed to see. '
          + 'Confidential documents and sick-leave details stay behind their own controls.',
        access: PERMISSIONS.STAFF_VIEW, accessLabel: 'Can open staff files',
        roleDefault: 'Administrators' },
      { key: 'staff-edit', name: 'Edit staff details', appliesIn: 'Staff file → Overview',
        description: 'Personal, contact, employment and professional details, and the photo.',
        access: PERMISSIONS.STAFF_EDIT, accessLabel: 'Can edit personal and employment details',
        roleDefault: 'Administrators' },
      { key: 'staff-onboard', name: 'Onboard new staff', appliesIn: 'HR Suite → Staff → Onboard',
        description: 'Creating a staff member\'s account with the onboarding wizard. What they '
          + 'can then do is still set here, by whoever may grant it.',
        access: PERMISSIONS.STAFF_ONBOARD, accessLabel: 'Can onboard new staff',
        roleDefault: 'Administrators' },
      { key: 'staff-status', name: 'Employment status', appliesIn: 'Staff file → Permissions',
        description: 'Suspending, recording a resignation or termination, archiving a file and '
          + 'restoring it. Anything other than Active or On leave stops them logging in.',
        access: PERMISSIONS.STAFF_STATUS, accessLabel: 'Can change employment status and archive',
        roleDefault: 'Administrators',
        warning: 'This person will be able to suspend or terminate a colleague, which stops '
          + 'that colleague logging in straight away.' },
      { key: 'staff-documents', name: 'Staff documents', appliesIn: 'Staff file → Documents',
        description: 'Uploading to someone else\'s file, reclassifying, archiving and restoring. '
          + 'Not the confidential drawer.',
        access: PERMISSIONS.STAFF_DOCUMENTS, accessLabel: 'Can manage colleagues\' documents',
        roleDefault: 'Administrators' },
      { key: 'users-confidential', name: 'Confidential staff documents', appliesIn: 'HR Suite, staff files',
        description: 'Contracts, appraisals, disciplinary letters — anything on a staff file '
          + 'marked "Admin only", and the archived files. Not part of full administrator '
          + 'access, and only a permissions administrator can grant it.',
        access: PERMISSIONS.HR_CONFIDENTIAL, accessLabel: 'Can see and classify confidential staff documents',
        roleDefault: 'Nobody by role — must be granted',
        warning: 'This person will be able to read every confidential document on every '
          + 'staff file, and to mark documents confidential or share them with the staff '
          + 'member. Full administrator access does not include this.' },
      { key: 'hr-lists', name: 'Departments and positions', appliesIn: 'HR Suite → Settings → Lists',
        description: 'The clinic\'s lists of departments and positions that staff files pick '
          + 'from, and the one-off screen that tidies what was typed before the lists existed.',
        access: PERMISSIONS.HR_LISTS, accessLabel: 'Can manage departments and positions',
        roleDefault: 'Administrators' },
      { key: 'hr-onboarding', name: 'Onboarding checklists', appliesIn: 'HR Suite → Onboarding, staff files',
        description: 'Seeing a new colleague\'s onboarding checklist, ticking the items HR does by '
          + 'hand (orientation, badge…), adding a one-off item, starting a checklist for someone '
          + 'already on the staff, and closing one early.',
        access: PERMISSIONS.HR_ONBOARDING, accessLabel: 'Can run onboarding checklists',
        roleDefault: 'Administrators' },
      { key: 'hr-onboarding-templates', name: 'Onboarding templates', appliesIn: 'HR Suite → Onboarding → Templates',
        description: 'The checklist each role starts with: its items, which tick themselves from '
          + 'the staff file, and how many days each is due after the start date.',
        access: PERMISSIONS.HR_ONBOARDING_TEMPLATES, accessLabel: 'Can edit onboarding templates',
        roleDefault: 'Administrators' },
      { key: 'hr-profile-approve', name: 'Profile change requests', appliesIn: 'HR Suite → Profile requests',
        description: 'Decide what colleagues ask to change on their own record — name, National '
          + 'ID, date of birth, licence and qualification details.',
        access: PERMISSIONS.HR_PROFILE_APPROVE, accessLabel: 'Can approve or reject profile change requests',
        roleDefault: 'Administrators' },
    ],
  },
  {
    key: 'hr-attendance',
    hr: true,
    name: 'HR Suite · Attendance',
    description: 'Everyone else\'s time and attendance. Check-in rules and tag keys are under '
      + 'HR administration.',
    areas: [
      { key: 'hr-attendance', name: 'See attendance', appliesIn: 'HR Suite → Dashboard, Time register',
        description: 'Who is in, flagged taps, the register and everyone\'s working hours.',
        access: PERMISSIONS.HR_VIEW, accessLabel: 'Can see everyone\'s attendance',
        roleDefault: 'Administrators' },
      { key: 'hr-attendance-amend', name: 'Amend attendance', appliesIn: 'HR Suite → Time register',
        description: 'Adding a missed check-in or check-out and correcting a session. Every '
          + 'change is kept with who made it.',
        access: PERMISSIONS.HR_ATTENDANCE_AMEND, accessLabel: 'Can amend attendance records',
        roleDefault: 'Administrators' },
      { key: 'hr-workhours', name: 'Working hours', appliesIn: 'HR Suite → Settings → Working hours',
        description: 'Setting a person\'s usual week and dated exceptions, which decide when '
          + 'they are expected in.',
        access: PERMISSIONS.HR_WORKHOURS, accessLabel: 'Can set working hours',
        roleDefault: 'Administrators' },
      { key: 'hr-roster', name: 'Shift roster', appliesIn: 'HR Suite → Roster',
        description: 'Building a department\'s week of shifts for nurses, lab and front office, '
          + 'copying last week and publishing it. A published shift becomes that person\'s '
          + 'expected hours for the day, so attendance and stars follow the roster.',
        access: PERMISSIONS.HR_ROSTER, accessLabel: 'Can build and publish the roster',
        roleDefault: 'Administrators' },
      { key: 'hr-roster-shifts', name: 'Shift types', appliesIn: 'HR Suite → Roster → Shift types',
        description: 'The clinic\'s list of shifts the roster picks from — name, start, end and '
          + 'colour. A shift that ends before it starts runs past midnight.',
        access: PERMISSIONS.HR_ROSTER_SHIFTS, accessLabel: 'Can define shift types',
        roleDefault: 'Administrators' },
      { key: 'hr-tags', name: 'Entrance tags', appliesIn: 'HR Suite → Settings → Tags',
        description: 'Naming, testing and retiring the entrance tags. Registering a new tag key '
          + 'is "HR Suite settings".',
        access: PERMISSIONS.HR_TAGS, accessLabel: 'Can manage entrance tags',
        roleDefault: 'Administrators' },
    ],
  },
  {
    key: 'hr-leave',
    hr: true,
    name: 'HR Suite · Leave',
    description: 'Everyone else\'s leave. Applying for their own is Self-service.',
    areas: [
      { key: 'leave-approve', name: 'Approve leave', appliesIn: 'HR Suite → Leave to approve',
        description: 'Can be chosen as an approver on a colleague\'s request and decide it, and '
          + 'choose which balance the days come off. The applicant picks their approvers; '
          + 'nobody approves their own leave.',
        access: PERMISSIONS.LEAVE_APPROVE, accessLabel: 'Can be chosen to approve leave',
        roleDefault: 'Administrators' },
      { key: 'leave-view', name: 'See everyone\'s leave', appliesIn: 'Leave to approve → All, staff files',
        description: 'Who is away, when and for how long, with the real leave type. Sick leave '
          + 'shows as "Private" unless they also hold "Sick-leave details".',
        access: PERMISSIONS.LEAVE_VIEW, accessLabel: 'Can see everyone\'s leave',
        roleDefault: 'Administrators' },
      { key: 'leave-sick', name: 'Sick-leave details', appliesIn: 'Leave, staff files, team calendar',
        description: 'That a leave was sick leave, the reason given and the sick note. Health '
          + 'data: give it to as few people as the work needs.',
        access: PERMISSIONS.LEAVE_SICK, accessLabel: 'Can see sick-leave details',
        roleDefault: 'Administrators',
        warning: 'Sick leave is health data. This person will see the type, reason and sick '
          + 'note of every colleague\'s sick leave.' },
      { key: 'leave-manage', name: 'Record and cancel leave', appliesIn: 'Staff file → Leave, Leave to approve',
        description: 'Recording leave on someone\'s behalf (approved on the spot) and cancelling '
          + 'anyone\'s live request. Also carries seeing everyone\'s leave, sick-leave details, '
          + 'required approvers and the register — untick any of those to hold it back.',
        access: PERMISSIONS.LEAVE_MANAGE, accessLabel: 'Can record and cancel leave for others',
        roleDefault: 'Administrators' },
      { key: 'leave-required', name: 'Required approvers', appliesIn: 'Staff file → Leave',
        description: 'Naming who must approve a person\'s leave, whatever they choose.',
        access: PERMISSIONS.LEAVE_REQUIRED, accessLabel: 'Can set required approvers',
        roleDefault: 'Administrators' },
      { key: 'leave-register', name: 'Leave register', appliesIn: 'Leave to approve → All',
        description: 'Downloading the year\'s leave register as a spreadsheet. Every download '
          + 'is logged. Sick leave is named only for someone who also holds "Sick-leave details".',
        access: PERMISSIONS.LEAVE_REGISTER, accessLabel: 'Can download the leave register',
        roleDefault: 'Administrators' },
      { key: 'leave-policy', name: 'Leave policy and types', appliesIn: 'HR Suite → Leave settings',
        description: 'The yearly leave policy (days per type, how weekdays count, carry-over, '
          + 'publishing) and the leave types. Also carries public holidays, entitlements and '
          + 'everything in "Record and cancel leave".',
        access: PERMISSIONS.LEAVE_POLICY, accessLabel: 'Can set the leave policy and types',
        roleDefault: 'Administrators' },
      { key: 'leave-holidays', name: 'Public holidays', appliesIn: 'Leave settings → Public holidays',
        description: 'Adding and retiring public holidays, and the Sunday-holiday rule.',
        access: PERMISSIONS.LEAVE_HOLIDAYS, accessLabel: 'Can manage public holidays',
        roleDefault: 'Administrators' },
      { key: 'leave-entitlements', name: 'Individual entitlements', appliesIn: 'Leave settings → Staff entitlements',
        description: 'Giving one person more or fewer days than the policy for a year.',
        access: PERMISSIONS.LEAVE_ENTITLEMENTS, accessLabel: 'Can set individual entitlements',
        roleDefault: 'Administrators' },
    ],
  },
  {
    key: 'hr-development',
    hr: true,
    name: 'HR Suite · Development',
    description: 'Professional development and credentials.',
    areas: [
      { key: 'cpd-verify', name: 'Verify CPD', appliesIn: 'HR Suite → Profile requests',
        description: 'Confirming, adjusting or rejecting the CPD points colleagues log, before '
          + 'they count.',
        access: PERMISSIONS.CPD_VERIFY, accessLabel: 'Can verify CPD',
        roleDefault: 'Administrators' },
      { key: 'hr-expiry-alerts', name: 'Expiry alerts', appliesIn: 'Bell and email',
        description: 'Receiving the clinic-wide reminders when a licence or staff document is '
          + 'about to expire, and seeing the list of what is expiring.',
        access: PERMISSIONS.HR_EXPIRY_ALERTS, accessLabel: 'Receives licence and document expiry alerts',
        roleDefault: 'Administrators' },
    ],
  },
  {
    key: 'hr-admin',
    hr: true,
    name: 'HR Suite · Administration',
    description: 'Clinic-wide HR rules, HR reports, and handing out HR controls.',
    areas: [
      { key: 'hr-settings', name: 'HR Suite settings', appliesIn: 'HR Suite → Settings',
        description: 'Check-in rules, registering entrance tag keys, CPD targets and which '
          + 'alerts go out by bell, email or WhatsApp.',
        access: PERMISSIONS.HR_SETTINGS, accessLabel: 'Can change HR Suite settings and register tag keys',
        roleDefault: 'Administrators',
        warning: 'Entrance tag keys are secrets: someone holding a key can make a tag that '
          + 'checks anyone in. Grant this only to whoever runs the HR Suite.' },
      { key: 'hr-reports', name: 'HR reports', appliesIn: 'HR Suite → Reports',
        description: 'Headcount and joiners/leavers, annual leave owed, licences and documents '
          + 'expiring, CPD progress and punctuality — on screen and as spreadsheets. Every '
          + 'download is logged. Sick leave appears only as one total of days, never by person.',
        access: PERMISSIONS.HR_REPORTS, accessLabel: 'Can see and download HR reports',
        roleDefault: 'Administrators' },
      { key: 'hr-grant', name: 'Grant HR permissions', appliesIn: 'Staff file → Permissions',
        description: 'Ticking and unticking the HR Suite controls on colleagues\' files — only '
          + 'the ones they hold themselves, never on their own file, and never confidential '
          + 'documents or this control. Every change is logged against their name.',
        access: PERMISSIONS.HR_GRANT, accessLabel: 'Can grant HR Suite permissions to others',
        roleDefault: 'Nobody by role — granted by a permissions administrator',
        warning: 'This person will be able to give colleagues any HR Suite control they hold '
          + 'themselves, including seeing sick-leave details. Only a permissions administrator '
          + 'can grant this.' },
    ],
  },
  {
    key: 'administration',
    name: 'Administration',
    description: 'Slices of the admin portal, for someone who should run one screen without '
      + 'holding everything an administrator can do.',
    areas: [
      { key: 'patient-records', name: 'Merge and delete patient records', appliesIn: 'Admin',
        description: 'Merging two records into one, deleting a patient, and undoing a merge. '
          + 'Irreversible, and separate from registering and editing a patient.',
        access: null, write: PERMISSIONS.PATIENTS_MERGE,
        readOpen: 'the duplicate list is part of the same capability',
        writeLabel: 'Can merge, delete and restore patient records',
        roleDefault: 'Administrators',
        warning: 'Merging and deleting patient records cannot be undone from the interface. '
          + 'Grant this only to someone who maintains the record itself.' },
      { key: 'system-setup', name: 'Beds, catalog and stock setup', appliesIn: 'Admin',
        description: 'Creating and editing beds, retiring a catalog item, rebuilding stock '
          + 'levels, archiving an ultrasound.',
        access: null, write: PERMISSIONS.ADMIN_SETUP,
        readOpen: 'the things being configured are readable through their own modules',
        writeLabel: 'Can set up beds, catalog and stock',
        roleDefault: 'Administrators' },
      { key: 'admin-all', name: 'Full administrator access', appliesIn: 'Admin',
        description: 'Every admin-only endpoint, including the three below. Anything set to '
          + 'Withdrawn still overrides this — a withdrawal always beats a grant.',
        // Marks a grant broad enough that a withdrawal elsewhere carves a hole in
        // it. The tab spells out the exceptions rather than leaving the card
        // claiming "everything" while something below is switched off.
        broad: true,
        access: PERMISSIONS.ADMIN_ACCESS, accessLabel: 'Can do everything an admin can',
        roleDefault: 'Administrators',
        warning: 'They will be able to do everything an administrator can, except grant permissions to others.' },
      { key: 'permissions-grant', name: 'Grant permissions to others', appliesIn: 'Admin',
        description: 'The right to change what other people can do — including making '
          + 'someone an administrator. Not part of full administrator access: an '
          + 'administrator runs the clinic, a permissions administrator decides who else may.',
        access: PERMISSIONS.PERMISSIONS_GRANT, accessLabel: 'Can grant and withdraw permissions',
        roleDefault: 'Nobody by role — must be granted by an existing holder',
        warning: 'This person will be able to make anyone an administrator, and to take '
          + 'that away. Only someone who already holds this can grant it, and nobody can '
          + 'grant it to themselves. Every change is recorded against their name.' },
      { key: 'users', name: 'Users and staff files', appliesIn: 'Admin, HR Suite',
        description: 'The Manage Users screen (login accounts). Viewing also carries "Open staff '
          + 'files"; editing also carries editing details, onboarding, employment status and '
          + 'staff documents — each of those can be given on its own under HR Suite · People.',
        access: PERMISSIONS.USERS_VIEW, write: PERMISSIONS.USERS_WRITE,
        accessLabel: 'Can view users and open staff files',
        writeLabel: 'Can create and edit users and staff files',
        roleDefault: 'Administrators' },
      { key: 'config', name: 'Catalog, wards and settings', appliesIn: 'Admin',
        access: null, write: PERMISSIONS.CONFIG_WRITE,
        writeLabel: 'Can change clinical catalog, wards and system settings',
        roleDefault: 'Administrators' },
      { key: 'monitoring', name: 'Monitoring and analytics', appliesIn: 'Admin',
        access: PERMISSIONS.MONITORING_VIEW, accessLabel: 'Can view activity log, analytics and reports',
        roleDefault: 'Administrators' },
    ],
  },
];

// Roles that may hold permissions at all. Patients are excluded outright: the
// patient portal is a different trust boundary, and no capability here makes
// sense for someone who is a subject of the records rather than a user of them.
const PERMISSIBLE_ROLES = ['doctor', 'staff', 'lab', 'nurse'];

// Every internal role. Read access to a patient's record is not restricted by
// cadre: anyone who works here and is looking at a patient file sees the whole
// file. Writes are NOT covered by this — each route keeps its own, narrower
// list for POST/PUT/DELETE, so who may *record* a clinical entry is unchanged.
//
// 'patient' is deliberately absent. The patient portal is a different trust
// boundary: a patient is the subject of these records, not a user of them, and
// doctors' notes are written on the understanding that patients do not read
// them. Routes that intentionally expose a patient's own data to them keep
// 'patient' listed explicitly alongside this spread.

/** A real admin account, as opposed to someone granted admin capabilities. */
/**
 * Everything the Permissions tab should show as TICKED for this person.
 *
 * Deliberately separate from effectivePermissions(), which is the storage
 * answer: what has been granted, minus what has been withdrawn. Access is
 * decided by more than that, and the difference is exactly where the tab used
 * to lie:
 *
 *   - a portal that comes with their ROLE is never stored, so every portal row
 *     rendered empty for the people who hold it;
 *   - ADMIN_ACCESS admits its holder to any gate listing 'admin', so sixteen
 *     capabilities they genuinely have showed as not-granted.
 *
 * Both cases produced the same broken-feeling behaviour: the box looked empty,
 * the admin ticked it, the screen correctly stored nothing — because they had
 * it already — and the box sprang back.
 *
 * NOT used by authorize() or requirePermission(). Widening those would change
 * who gets through a gate; this only changes what a screen draws.
 */
const displayedPermissions = (user) => {
  if (!user) return [];
  if (isTrueAdmin(user)) return [...ALL_PERMISSIONS];

  const shown = effectivePermissions(user);
  const refused = deniedPermissions(user);

  // Portals, resolved rather than stored.
  ALL_PERMISSIONS
    .filter((p) => p.startsWith('portal.'))
    .filter((p) => canOpenPortal(user, p))
    .forEach((p) => shown.add(p));

  // What full administrator access carries with it. A withdrawal still wins —
  // "everything an admin can do, except the activity log" has to stay
  // expressible, and the tab has to draw it correctly.
  if (shown.has(PERMISSIONS.ADMIN_ACCESS)) {
    ADMIN_ACCESS_COVERS
      .filter((p) => !refused.has(p))
      .forEach((p) => shown.add(p));
  }

  return [...shown];
};

const isTrueAdmin = (user) => user?.role === 'admin';

/**
 * May this person grant or withdraw capabilities on someone else?
 *
 * Holds the key (permissions.grant) OR is the true admin account — the latter
 * is the deliberate no-lockout fallback. NOT satisfied by admin.access alone:
 * that is the whole point of the capability. See PERMISSIONS_GRANT.
 */
const canGrantPermissions = (user) =>
  isTrueAdmin(user) || hasPermission(user, PERMISSIONS.PERMISSIONS_GRANT);

/**
 * Exactly what authorize('admin', capability) would answer, for use INSIDE a
 * controller or a bespoke middleware.
 *
 * Three ways in — the true admin account, a holder of admin.access, or a holder
 * of the capability itself — unless the capability has been withdrawn from this
 * person, which beats everything (the same order authorize() checks in).
 * hasPermission() alone does NOT know about the admin.access bypass, so a
 * doctor + admin.access (the way the clinic intends to run once the true admin
 * account is benched) would be refused by it. Mirrors the frontend helper of
 * the same name in cdc-hms/src/utils/permissions.js. Never gate on
 * `role === 'admin'` in new code; use this.
 */
const passesAdminGate = (user, capability) =>
  !isDenied(user, capability)
  && (isTrueAdmin(user)
      || hasPermission(user, PERMISSIONS.ADMIN_ACCESS)
      || hasPermission(user, capability));

/**
 * The pure form of authorize(...allow): 'ok', 'denied' (a capability named in
 * the gate has been withdrawn from this person — beats everything), or 'no'.
 * Roles and dotted capabilities in one list, exactly as authorize() takes them;
 * authorize() is built on this, so an inline check in a controller or service
 * can never drift from the route gate it mirrors.
 */
const gateResult = (user, allow) => {
  if (!user) return 'no';
  const roles = allow.filter((a) => !a.includes('.'));
  const perms = allow.filter((a) => a.includes('.'));
  if (perms.some((p) => isDenied(user, p))) return 'denied';
  if (roles.includes(user.role)) return 'ok';
  if (roles.includes('admin') && hasPermission(user, PERMISSIONS.ADMIN_ACCESS)) return 'ok';
  if (perms.some((p) => hasPermission(user, p))) return 'ok';
  return 'no';
};
const passesGate = (user, allow) => gateResult(user, allow) === 'ok';

/**
 * May this person open the confidential drawer of a staff file?
 *
 * An explicit grant of hr.confidential, or the true admin account. NOT
 * satisfied by admin.access — see HR_CONFIDENTIAL. A withdrawal still wins.
 */
const canViewConfidential = (user) =>
  !isDenied(user, PERMISSIONS.HR_CONFIDENTIAL)
  && (isTrueAdmin(user) || hasPermission(user, PERMISSIONS.HR_CONFIDENTIAL));

/**
 * A JSON-array column, as a real array.
 *
 * Sequelize hands a JSON column back already parsed on MySQL, but as a raw
 * string on some drivers and on MariaDB (where JSON is longtext plus a
 * json_valid() CHECK). Treating a string as "not an array" would silently
 * resolve to NO capabilities — every check failing closed, the user locked out
 * of everything, and nothing logged. Tolerating both shapes costs one branch.
 */
const toList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
};

/**
 * A stored list of capability strings, as a Set of current names: legacy names
 * expanded to what they mean now, unknown names dropped.
 */
const expand = (list) => {
  const out = new Set();
  toList(list).forEach((name) => {
    if (LEGACY_PERMISSIONS[name]) LEGACY_PERMISSIONS[name].forEach((p) => out.add(p));
    else if (ALL_PERMISSIONS.includes(name)) out.add(name);
  });
  return out;
};

/**
 * Capabilities explicitly WITHDRAWN from this user — the restrictive half of
 * the model. A grant adds to what a role allows; a denial subtracts from it,
 * so an admin can hold one person out of an area their role would otherwise
 * open.
 *
 * A real admin account can never be denied anything. Allowing it would let an
 * administrator lock themselves — or the last remaining administrator — out of
 * the screen that grants permissions, with no way back in through the UI.
 */
const deniedPermissions = (user) => {
  if (!user || isTrueAdmin(user)) return new Set();
  // Withdrawing a bundle withdraws its parts (see BUNDLES): someone refused
  // users.write before Tier 3 must still be refused editing staff files now
  // that the staff routes check staff.edit.
  return withBundleDenials(expand(user.deniedPermissions));
};

/**
 * Everything a user can do, as a Set.
 *
 * A real admin implicitly holds every permission — that is what the role means,
 * and storing the list on the admin row would just be a second thing to keep in
 * sync. Anyone else holds what has been granted, minus what has been withdrawn:
 * a denial beats a grant, so revoking is never ambiguous.
 *
 * Staff-type defaults are folded in here rather than written to the row, for
 * the same reason the admin's list is not stored: the bundle is a property of
 * being clinical, so reclassifying one person must not require rewriting their
 * permissions column, and changing what "clinical" means must not require a
 * data migration over every clinical account.
 *
 * A withdrawal still beats a type default — the deletes run last. That is what
 * makes "clinical, except this one thing" expressible, which is the whole point
 * of having a Permissions tab on top of the classification.
 */
const effectivePermissions = (user) => {
  if (!user) return new Set();
  if (isTrueAdmin(user)) return new Set(ALL_PERMISSIONS);
  const granted = expand(user.permissions);
  typeDefaultPermissions(user).forEach((p) => granted.add(p));

  // Apply the implications HERE, not only when a row is written.
  //
  // sanitizePermissions() adds the implied read whenever the tab saves, so a
  // row written through the UI is always consistent. Nothing else was: a row
  // written by the older Manage Users screen, a legacy 'stock.manage'
  // expansion, a direct API call or a hand-edited database left someone
  // holding stock.write without stock.access — able to move the ledger while
  // the read middleware refused them, which is a state no screen can show and
  // nobody can debug from the UI.
  //
  // routes/stock.js has said "a holder of stock.write always holds
  // stock.access too (constants/permissions.js enforces the implication)"
  // since the stock split. That was only true at write time. This makes the
  // comment true.
  //
  // Before the deletes, so a withdrawal still beats an implication: taking away
  // the read has to take the write with it, which is what
  // sanitizeDeniedPermissions already records.
  //
  // Bundles resolve here too (HR Tier 3): holding leave.manage holds its parts.
  const carried = withCarried(granted);

  deniedPermissions(user).forEach((p) => carried.delete(p));
  return carried;
};

const hasPermission = (user, permission) => effectivePermissions(user).has(permission);

/** Has this capability been explicitly withdrawn from this user? */
const isDenied = (user, permission) => deniedPermissions(user).has(permission);

/**
 * May this user open this portal shell?
 *
 * Their own role's portal always, plus anything granted, minus anything
 * withdrawn. Shared with the frontend through the session payload so
 * ProtectedRoute and this agree on one answer.
 */
const canOpenPortal = (user, portalPermission) => {
  if (!user) return false;
  if (isTrueAdmin(user)) return true;
  if (isDenied(user, portalPermission)) return false;
  if ((ROLE_DEFAULT_PORTALS[user.role] || []).includes(portalPermission)) return true;
  // Full administrator access carries the door with it. The reverse implication
  // was removed (see IMPLIED_BY), but this direction still holds: every admin
  // power and no way to reach the portal would be the same trap mirrored.
  if (portalPermission === PERMISSIONS.PORTAL_ADMIN
      && hasPermission(user, PERMISSIONS.ADMIN_ACCESS)) return true;
  return hasPermission(user, portalPermission);
};

/**
 * Normalise a capability list coming from a client: legacy names translated,
 * unknown names dropped, duplicates removed, order stable. Returning only known
 * permissions means a typo silently grants nothing rather than storing a string
 * that looks like a permission and is never checked.
 */
const sanitizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const set = expand(input);
  // A write is meaningless without the access it acts within, so granting one
  // carries the other. Without this the tab could store "can dispense but
  // cannot open Stock", which no screen can represent and no gate expects.
  // Repeated until stable — leave.policy → leave.manage → leave.view.
  let grew = true;
  while (grew) {
    grew = false;
    Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
      if (set.has(held) && !set.has(implied)) { set.add(implied); grew = true; }
    });
  }
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

/**
 * Normalise a denial list. Same rules, with the implication inverted:
 * withdrawing an area's access necessarily withdraws the ability to act in it,
 * or a denied user would still reach the write routes.
 */
const sanitizeDeniedPermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const set = expand(input);
  // Repeated until stable: refusing leave.view refuses leave.manage, which
  // refuses leave.policy (a chain that only exists since HR Tier 3).
  let grew = true;
  while (grew) {
    grew = false;
    Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
      if (set.has(implied) && !set.has(held)) { set.add(held); grew = true; }
    });
  }
  return ALL_PERMISSIONS.filter((p) => set.has(p));
};

/**
 * A granted list and a denied list, made consistent with each other.
 *
 * A capability cannot be granted and withdrawn at once. The withdrawal wins —
 * it is the more restrictive statement, and it is what effectivePermissions()
 * would conclude anyway, so storing anything else would leave a row that reads
 * differently from how it behaves. Shared by staffController.updatePermissions
 * and userController.createStaffAccount so the two writing paths cannot drift.
 *
 * Returns { granted, denied, conflicting } — `conflicting` is what was in both
 * lists, for the caller to log.
 */
const reconcilePermissionLists = (permissions, deniedPermissions) => {
  const nextGranted = sanitizePermissions(permissions);
  const denied = sanitizeDeniedPermissions(deniedPermissions);
  const conflicting = nextGranted.filter((p) => denied.includes(p));
  const granted = nextGranted.filter((p) => !denied.includes(p));
  return { granted, denied, conflicting };
};

/**
 * What a person of this role and staff type holds with NOTHING ticked either
 * way: the portals their role opens plus whatever their staff type carries.
 *
 * This is the baseline the Permissions tab and the onboarding wizard both
 * compare against to decide what a tick has to STORE (a grant, a withdrawal,
 * or nothing). One helper so the Staff File and the wizard can never disagree
 * about what "default" means for a nurse. The role is checked against
 * PERMISSIBLE_ROLES + admin so a stray value cannot manufacture a baseline.
 */
const defaultPermissionsFor = (role, staffType) => {
  if (!INTERNAL_ROLES.includes(role)) return [];
  return [
    ...new Set([
      ...effectivePermissions({ role, staffType, permissions: [], deniedPermissions: [] }),
      ...(ROLE_DEFAULT_PORTALS[role] || []),
    ]),
  ];
};

// The capabilities a PERMISSION PRESET may never contain.
//
// A preset is a bundle a permissions administrator approved once so that a
// users.write holder can apply it to a new hire without a second person
// (decision of record, 24 Sep 2026). That only stays safe if the three
// capabilities whose whole design is "granted deliberately, per person, by a
// key-holder" can never ride along inside a template:
//   - admin.access       — full administrator access is a separate, named act
//   - permissions.grant  — must not propagate (see PERMISSIONS_GRANT)
//   - hr.confidential    — reading a colleague's contract is its own trust
// Served to the UI by the catalog endpoint and enforced on every preset write.
const PRESET_EXCLUDED = [
  PERMISSIONS.ADMIN_ACCESS,
  PERMISSIONS.PERMISSIONS_GRANT,
  PERMISSIONS.HR_CONFIDENTIAL,
  // HR Tier 3 (P-5): only a permissions administrator makes an HR grantor, so
  // it can never ride inside a template a users.write holder may apply.
  PERMISSIONS.HR_GRANT,
];

// ---------------------------------------------------------------------
// Delegated HR granting (HR Tier 3 Phase 0, decisions P-2, P-5, P-6)
// ---------------------------------------------------------------------

// HR capabilities a "Grant HR permissions" holder may never hand out: the
// confidential drawer (outside admin access on purpose) and hr.grant itself
// (no chains). Appraisal reading joins this list when appraisals ship.
const HR_NOT_DELEGABLE = [PERMISSIONS.HR_CONFIDENTIAL, PERMISSIONS.HR_GRANT];

// Everything in the HR Suite groups of the Permissions tab, minus the above.
// Derived from PERMISSION_GROUPS so a new HR control is delegable the moment
// it appears on the tab.
const HR_DELEGABLE = PERMISSION_GROUPS
  .filter((g) => g.hr)
  .flatMap((g) => g.areas)
  .flatMap((a) => [a.access, a.write])
  .filter(Boolean)
  .filter((p) => !HR_NOT_DELEGABLE.includes(p));

/**
 * May this person use the delegated HR granting path?
 *
 * An explicit hr.grant (or the true admin account), not withdrawn. Like
 * permissions.grant it is NOT satisfied by admin.access: holding full
 * administrator access runs the clinic; handing out HR controls is a separate,
 * named trust.
 */
const canGrantHrPermissions = (user) =>
  isTrueAdmin(user) || hasPermission(user, PERMISSIONS.HR_GRANT);

/** Either kind of grantor — who may open the Permissions tab for editing at all. */
const canEditPermissions = (user) => canGrantPermissions(user) || canGrantHrPermissions(user);

// ---------------------------------------------------------------------
// Department scopes on HR controls (HR Tier 3 Phase 1, P-1/P-7/P-8)
// ---------------------------------------------------------------------

// The HR controls that act on PEOPLE, and so can be limited to departments on
// the Permissions tab (All staff · their own department · named departments).
// Everything else in the HR groups changes a clinic-wide rule (policy, holidays,
// settings, lists, tags, onboarding templates, shift types) or is chosen per request (leave.approve)
// or is one's own (hr.self, hr.checkin) — none of those can be narrowed.
// A control with no scope rows is "All staff". Resolved by utils/hrScope;
// stored by services/hrScope (PermissionScopes). permissionVocabulary.test
// checks every entry here is a real HR control.
const SCOPABLE = [
  PERMISSIONS.STAFF_VIEW,
  PERMISSIONS.STAFF_EDIT,
  PERMISSIONS.STAFF_STATUS,
  PERMISSIONS.STAFF_DOCUMENTS,
  PERMISSIONS.HR_CONFIDENTIAL,
  PERMISSIONS.HR_PROFILE_APPROVE,
  PERMISSIONS.HR_VIEW,
  PERMISSIONS.HR_ATTENDANCE_AMEND,
  PERMISSIONS.HR_WORKHOURS,
  PERMISSIONS.LEAVE_VIEW,
  PERMISSIONS.LEAVE_SICK,
  PERMISSIONS.LEAVE_MANAGE,
  PERMISSIONS.LEAVE_REQUIRED,
  PERMISSIONS.LEAVE_REGISTER,
  PERMISSIONS.LEAVE_ENTITLEMENTS,
  PERMISSIONS.CPD_VERIFY,
  PERMISSIONS.HR_EXPIRY_ALERTS,
  PERMISSIONS.HR_GRANT,
  PERMISSIONS.HR_REPORTS,
  PERMISSIONS.HR_ONBOARDING,
  PERMISSIONS.HR_ROSTER,
];

// Roles a preset can be defined for — the same set that may hold permissions.
const PRESET_ROLES = PERMISSIBLE_ROLES;

module.exports = {
  PERMISSIONS,
  toList,
  ALL_PERMISSIONS,
  LEGACY_PERMISSIONS,
  PERMISSION_GROUPS,
  ROLE_DEFAULT_PORTALS,
  PERMISSIBLE_ROLES,
  INTERNAL_ROLES,
  CLINICAL_READ_ROLES,
  STAFF_TYPES,
  TYPE_DEFAULT_PERMISSIONS,
  isClinical,
  typeDefaultPermissions,
  ADMIN_ACCESS_COVERS,
  displayedPermissions,
  effectivePermissions,
  deniedPermissions,
  hasPermission,
  isDenied,
  canOpenPortal,
  isTrueAdmin,
  canGrantPermissions,
  passesAdminGate,
  gateResult,
  passesGate,
  canViewConfidential,
  sanitizePermissions,
  sanitizeDeniedPermissions,
  reconcilePermissionLists,
  defaultPermissionsFor,
  PRESET_EXCLUDED,
  PRESET_ROLES,
  SCOPABLE,
  BUNDLES,
  IMPLIED_BY,
  withCarried,
  HR_DELEGABLE,
  HR_NOT_DELEGABLE,
  canGrantHrPermissions,
  canEditPermissions,
};
