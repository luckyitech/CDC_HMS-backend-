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
  HR_WRITE:   'hr.write',

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
// than by running the migration. Nothing new should ever be added here.
const LEGACY_PERMISSIONS = {
  'stock.manage': [PERMISSIONS.STOCK_ACCESS, PERMISSIONS.STOCK_WRITE],
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
  [PERMISSIONS.HR_WRITE]:           PERMISSIONS.HR_VIEW,
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
  PERMISSIONS.HR_CHECKIN,
  PERMISSIONS.HR_VIEW,
  PERMISSIONS.HR_WRITE,
  PERMISSIONS.INPATIENT_ACCESS,
  PERMISSIONS.INPATIENT_WRITE,
  PERMISSIONS.LAB_VIEW,
  PERMISSIONS.LABINBOX_VIEW,
  PERMISSIONS.LABINBOX_WRITE,
  PERMISSIONS.MONITORING_VIEW,
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
    ],
  },
  {
    key: 'hr',
    name: 'HR Suite',
    description: 'Staff time & attendance. Everyone can check in and see their own record; '
      + 'these decide who can see and amend everyone\'s.',
    areas: [
      { key: 'hr-checkin', name: 'Check in and out', appliesIn: 'HR Suite, entrance tag',
        description: 'Tapping the entrance tag, remembering a phone, and seeing their own '
          + 'attendance and stars. Held by every member of staff; withdraw it to stop one '
          + 'person checking in.',
        access: PERMISSIONS.HR_CHECKIN, accessLabel: 'Can check in and out and see their own record',
        roleDefault: 'Everyone' },
      { key: 'hr-attendance', name: 'Time & Attendance', appliesIn: 'HR Suite',
        description: 'Who is in, flagged taps, the register and amendments; working hours '
          + 'and entrance tags. Tag keys and the check-in rules also need "Catalog, wards '
          + 'and settings" below.',
        access: PERMISSIONS.HR_VIEW, write: PERMISSIONS.HR_WRITE,
        accessLabel: 'Can see everyone\'s attendance',
        writeLabel: 'Can amend records, set working hours and manage tags',
        roleDefault: 'Administrators' },
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
      { key: 'users', name: 'Users and staff files', appliesIn: 'Admin',
        access: PERMISSIONS.USERS_VIEW, write: PERMISSIONS.USERS_WRITE,
        accessLabel: 'Can view users', writeLabel: 'Can create and edit users',
        roleDefault: 'Administrators' },
      { key: 'users-confidential', name: 'Confidential staff documents', appliesIn: 'Admin, HR Suite',
        description: 'Contracts, appraisals, disciplinary letters — anything on a staff file '
          + 'marked "Admin only", and the archived files. Not part of full administrator '
          + 'access: an administrator can manage the file without reading what is in the '
          + 'confidential drawer.',
        access: PERMISSIONS.HR_CONFIDENTIAL, accessLabel: 'Can see and classify confidential staff documents',
        roleDefault: 'Nobody by role — must be granted',
        warning: 'This person will be able to read every confidential document on every '
          + 'staff file, and to mark documents confidential or share them with the staff '
          + 'member. Full administrator access does not include this.' },
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
  return expand(user.deniedPermissions);
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
  Object.entries(IMPLIED_BY).forEach(([writeCap, readCap]) => {
    if (granted.has(writeCap)) granted.add(readCap);
  });

  deniedPermissions(user).forEach((p) => granted.delete(p));
  return granted;
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
  Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
    if (set.has(held)) set.add(implied);
  });
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
  Object.entries(IMPLIED_BY).forEach(([held, implied]) => {
    if (set.has(implied)) set.add(held);
  });
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
  canViewConfidential,
  sanitizePermissions,
  sanitizeDeniedPermissions,
  reconcilePermissionLists,
  defaultPermissionsFor,
  PRESET_EXCLUDED,
  PRESET_ROLES,
};
