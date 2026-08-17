# CDC HMS — Project Tracking

Running record of features, fixes and significant changes. A task is only marked
`Completed` once it has been implemented **and** tested, with the completion date recorded.

---

## In Progress

### HMS-improvements integration

- **Branch:** `integration/hms-improvements-safe`
- **Status:** Implemented — **awaiting testing against a real database**
- **Started:** 2026-08-12
- **Plan:** `HMS-IMPROVEMENTS-MERGE-PLAN.md`
- **Description:** Takes the conflict-free scope of `HMS-improvements` onto main: the
  permission-aware `authorize()` seam and `inpatient.access` capability, the admission and
  referral "Save & Print" endpoints, the merge-aware Visit History reads, and admissions
  routing through billing instead of bypassing it.

  The branch's staff-document vertical slice is **deliberately not taken** — main's
  implementation is more developed (nested under the staff API, `adminOrSelf` access,
  `visibility` ENUM, an `update` endpoint), and both create a `StaffDocuments` table
  behind a `showAllTables` guard, so merging both would have created the table with the
  wrong schema and failed silently at the first upload.

Backend:
- `middleware/auth.js` — `authorize()` accepts capabilities alongside roles
- `constants/permissions.js` — `INPATIENT_ACCESS`; applied across 10 inpatient routes
- `POST /admissions/note`, `POST /queue/:id/refer-note` — document a note without billing
- `GET /admissions/advised`, `GET /queue/advised-referrals` — uhid-scoped, merge-aware
- `requestAdmission` merges `selectedCharges` / `selectedProcedures`
- Migrations `20260811000006` (referral note) and `20260812000001` (admission note saved-at),
  both `describeTable`-guarded and re-runnable

Fixes applied on top of the branch during review:
- `advised-referrals` was missing `admin`, so an admin viewing a patient file silently lost
  referral notes (the frontend `.catch` hid the 403)
- Neither Save & Print endpoint carried the `status === 'With Doctor'` guard that `refer()`
  has — any doctor could write a note onto any queue row by id
- `saveNote` stamped `admissionRequestedAt`, making a merely-documented note look requested;
  it now writes `admissionNoteSavedAt` and leaves the request fields to `requestAdmission`

**Verification done so far:** all changed files parse; frontend builds and lints clean;
`tests/authorizeCapabilities.test.js` added (10 assertions, no database) covering the
capability seam and the advised-referrals gate. **Not yet run against a real database, and
not yet exercised in a browser.**

#### ⚠️ Deploy order — migrations MUST run before the new code starts

`models/Queue.js` declares `referralNote`, `referralNoteSavedAt`,
`referralNoteByDoctorName` and `admissionNoteSavedAt`. `server.js` runs
`sequelize.sync({ alter: false })`, which does **not** add columns to an existing
table — it only creates missing tables. So deploying the code without the
migrations gives a server that boots cleanly ("Models synced", port open) and
then fails **every** `Queue` query with `Unknown column`: the OPD board, triage,
refer, admissions, dashboard, analytics, reports and stock dispensing all return
500 at once, while the boot log looks healthy.

```
git pull            # or deploy the new build
npm run migrate     # 20260811000006 + 20260812000002 — additive, guarded, re-runnable
pm2 restart <app>   # only after the migration succeeds
```

Both migrations append nullable columns with no `after:` clause, so on MySQL
8.0.12+ they qualify for `ALGORITHM=INSTANT` — no table rewrite. On 5.7, or 8.0
with a non-DYNAMIC row format, each takes a brief exclusive metadata lock at
start and end; run off-peak, and make sure no long-running transaction is open
against `Queues` or the ALTER will stall behind it and queue every query after it.

Do **not** run `migrate:undo` after go-live without a dump first — `down()` drops
the columns and the clinical notes attributed by them.

#### Outstanding before this can be marked Completed

- [x] Run `npm test` against a real database — done 2026-08-17 during the round-2
      integration: 144 pass / 5 fail, the 5 identical to `main`'s own baseline
- [ ] Clinical walkthrough: admit and refer both routing through the billing modal
- [ ] Re-apply the branch's User Management tab consolidation to `StaffFile.jsx`
- [x] Add `updatedById` to `StaffDocuments` — done 2026-08-17, with a `lastEditor`
      association and JWT attribution in the update handler
- [ ] Decide whether Save & Print should version each save. Today the note is a
      column on the queue row, so a second save overwrites the first and one visit
      holds at most one admission note and one referral note. A separate table
      would keep every version — cheaper to decide now than to migrate later.
- [ ] `inpatient.access` currently also opens `routes/radiology.js` and
      `routes/inpatientBilling.js`, whose list endpoints are not inpatient-scoped —
      a granted user sees outpatient radiology orders too. Narrow the scope or the
      capability.

---

### HMS-improvements integration — round 2

- **Branch:** `integration/hms-improvements-r2` (both repos), merged to `main`
- **Status:** Implemented and merged — **awaiting the clinical walkthrough**
- **Started / merged:** 2026-08-17
- **Plan:** project docs `HMS-improvements-merge-plan-round2.md` and
  `HMS-improvements-r2-integration-results.md`
- **Description:** Takes the genuinely new work from `HMS-improvements`: nursing
  notes (the DAR Kardex), the visit workflow history endpoint, triage timestamps
  and vitals attribution, and on the frontend the unified patient file, the
  nursing workflow, the visit timeline and the PWA stability fixes.

`HMS-improvements` was never rebased on main, so for the second round running it
carried commits whose equivalents main already had in a better shape. Two were
dropped:

- `f3648ea` — the staff-document slice, dropped again for the round-1 reasons,
  and it drags a migration that collides with main's `20260811000001`.
- `f0c4fb3` — a second role vocabulary (`constants/roles.js` / `RECORD_READERS`)
  solving the nurse-403 problem main had already solved with
  `CLINICAL_READ_ROLES`. Its set omits `lab` and would have re-opened diagnoses,
  assessments and physical exams to `staff`, undoing `3cfe768`. The write gates
  it carried were re-applied by hand in main's vocabulary instead — nurse added
  to 13 write gates and 7 read gates, adding `'nurse'` only, so no gate lost a
  role.

Backend:
- Nursing notes vertical slice — model, controller, routes, `GET /api/queue/patient/:uhid`
- Migrations `20260813000001`, `20260816000001`, `20260817000001`, `20260817000002`,
  all guarded and idempotent, no timestamp collisions with main
- `deletedBy` / `deletedAt` on `NursingNotes` (`20260817000003`) — a soft-deleted
  clinical note now records who removed it and when
- `updatedById` on `StaffDocuments` (`20260817000004`)

Frontend:
- Unified patient file: shared tab set plus a queue-gated, role-specific live tab
  (doctor → Today's Consultation, staff/nurse → Nursing, admin → neither)
- Visit History gains Doctor's Notes / Nursing / Visit Timeline per day
- Doctor's-notes pagination fix — Visit History fetched one page while the API
  pages at 20, so a patient with more than 20 notes silently showed only the 20
  most recent. It now walks every page.

**Verification done:** both cherry-picks clean; all migrations applied to a
database seeded at main state and re-run as no-ops; `NursingNotes` schema and FKs
checked; delete- and edit-attribution exercised end-to-end against a live MySQL;
backend `npm test` **identical to main's baseline** (144 pass / 5 fail — the same
5 fail on `main` today); frontend builds and lints clean; notes pagination
unit-tested across page boundaries and failure cases.

#### Outstanding before this can be marked Completed

- [ ] **Clinical walkthrough — not yet done.** Open the Patient File as doctor,
      nurse, staff and admin; run a live visit through triage → Kardex → send to
      doctor → consultation → billing; check the Visit Timeline and every print
      button.
- [ ] Run `npm run migrate` against a copy of the real dev database. The
      sandbox run used a schema built by `sequelize.sync()` at main state, which
      is close to but not identical to a database grown migration-by-migration.
- [ ] Assessments, physical exams, treatment plans and prescriptions in Visit
      History still use the API's `limit = 20` default (pre-existing on main, not
      introduced here). The same `fetchAllNotes` helper generalises to them.
- [ ] `3cfe768` narrowed the assessment and physical-exam reads to
      `'doctor', 'admin'`. Its message describes restricting `staff`, but
      replacing `CLINICAL_READ_ROLES` with a literal also removed `nurse` and
      `lab`. Confirm that is what was intended — a nurse cannot currently read
      assessments or physical exams in the unified Patient File.
- [ ] `main` has 5 failing tests (permission grant-escape, stock ledger rules).
      They predate this work and fail identically with or without it.

---

### Staff Profiles (doctor / nurse / lab tech / staff)

- **Branch:** `feature/staff-profiles`
- **Status:** Phases 1–3 implemented — **awaiting testing against a real database**
- **Started:** 2026-08-11
- **Design doc:** [STAFF_PROFILE_DESIGN.md](STAFF_PROFILE_DESIGN.md)
- **Description:** An admin profile page for a single member of staff, built on the same page
  pattern as the existing patient profile. Consolidates `DoctorProfile` / `StaffProfile` /
  `LabTechProfile` into one `StaffProfile` table with shared columns plus a `roleDetails` JSON
  column, and adds an `employeeId` identifier, demographics, emergency contact, licence tracking,
  employment status and audit fields.

  Closes two existing gaps: nurses had no profile table of their own, and `CreateStaff.jsx`
  collected identity and contact fields that the backend silently discarded.

#### Phase 1 — profile record and page *(implemented, not yet tested)*

Backend:
- `models/StaffProfile.js` rewritten as the single profile table for every cadre
- Migrations `20260811000001/2/3` — add columns, backfill from the old tables, assign `EMP###`
  and add the unique index. All guarded and re-runnable.
- `generateEmployeeId` in `utils/generateId.js`
- `utils/auditChanges.js` — `buildChanges` extracted so userController and staffController
  produce identical audit entries
- `constants/staffRoles.js` — shared `STAFF_ROLES` / `DEFAULT_POSITION`
- `middleware/findStaff.js`, `controllers/staffController.js`, `routes/staff.js`, mounted at
  `/api/staff`
- `userController.js` — four create paths collapsed onto one shared `createStaffAccount`
  helper; reads, updates and lookups moved to `StaffProfile`; delete now archives
- `DoctorProfile` joins moved to `StaffProfile` in appointment, prescription, publicBooking
  and auth controllers
- `routes/users.js` — shared identity validators, `shift` made optional

Frontend:
- `services/staffService.js`
- `pages/admin/StaffProfile.jsx` — compact header + Overview / Credentials / Activity tabs
- `App.jsx` route `admin/staff-profile/:employeeId`
- `ManageUsers.jsx` — names link to the profile, archive wording replaces delete wording
- `CreateStaff.jsx` — now sends the fields it already collected; real shift dropdown

**Verification done so far:** all changed files parse; the Express app boots; all nineteen
`/api/staff` routes are mounted and reject unauthenticated requests; ESLint clean; 32 unit
assertions pass covering employee-ID generation, the audit diff, licence-expiry derivation,
inclusive leave-day counting (including a DST boundary and a leap day), date-range overlap,
and leave-type agreement across controller, model and migration.

**Not yet done:** running the migrations against a real MySQL database, and manual testing.
The sandbox has no MySQL and the installed `node_modules` are Windows binaries, so neither
could be verified here.

#### Phase 1b — inline editing *(implemented, not yet tested)*

Each profile section edits in place via `EditableSection`, sending only changed fields,
instead of one modal covering the whole record. `EditUserModal` remains for Manage Users and
was extended with the identity, contact, employment and licence fields plus a nurse entry —
without it the page displayed fields nobody could fill in.

#### Phase 2 — access *(partially implemented, not yet tested)*

- `staffController` now returns `permissions`, `canManageStock`, `hasAdminAccess`,
  `canHoldPermissions`, `isTrueAdmin` and `passwordChangedAt`
- `PATCH /api/staff/:employeeId/permissions`, restricted to a real admin account via
  `requireTrueAdmin` so the capability cannot propagate and become unrevocable
- `GET /api/staff/permissions/catalog` so the UI keeps no copy of the permission list
- Access tab: account state, permission toggles, and the archive/restore block
- Read paths now exclude `password`, `resetToken` and `resetTokenExpires`

**Still to do:** editable role bundles (`Roles` / `UserRoles`), `requirePermission` on
selected endpoints, and the permission-aware sidebar. The vocabulary is still just
`admin.access` and `stock.manage` — the module-level permissions are not added yet.

#### Phase 3 — leave and documents *(implemented, not yet tested)*

- `StaffLeave`, `LeaveBalance`, `StaffDocument` models; migrations `20260811000004/5`
- `utils/leaveDays.js` — inclusive day counting in UTC, optional weekend exclusion
- `leaveController` — request, approve, reject, cancel, and yearly entitlement.
  **Approving a doctor's leave writes one all-day `DoctorBlock` per date** so reception
  cannot book them while away; cancelling removes exactly those blocks by stored ID
- `staffDocumentController` + `middleware/uploadStaffDocument.js` — separate table and
  separate `uploads/staff-documents` directory from patient documents, `.doc`/`.docx`
  accepted alongside PDF and images, extension and MIME both validated, files streamed
  through an authenticated route with a path-traversal guard
- Leave and Documents tabs, with staff self-service (own leave request, own uploads)

**Deferred — staff self-service.** The API is ready: every leave and document route is
`adminOrSelf`, and a staff member's own leave request is created `Pending` rather than
approved. What is missing is the way in — the staff file sits under `/admin/...`, which is
`requiredRole="admin"`, so no other portal can reach it.

Until that is built, **leave is admin-recorded only**: the staff member tells the admin, the
admin records it, and it is approved on the spot.

To finish it later: a "My Profile" route in each portal rendering `StaffFile` with `isAdmin`
false, resolving the employee ID from the session rather than the URL — they would see
Documents and Leave only. Two decisions still open:
- which portals get the sidebar entry (all four, or only staff and nurse)
- whether a pending request notifies an admin; nothing does today, and they would have to open
  the person's file to notice. The `Notification` model already exists.

**Still out of scope:** attendance; performance and payroll remain parked.

- **Next step:** run the five migrations on a copy of production data, confirm the backfill
  produced one `StaffProfile` per staff user with sensible employee IDs, then test the page.
- **Explicitly out of scope:** performance metrics, payroll, attendance/clock-in, occupational
  health records, ward-scoped access. See §9 of the design doc.

---

## Flagged, not fixed

Issues found while working on the above. Each needs its own branch.

- **`listUsers` does not select the `permissions` column** — `controllers/userController.js`
  line ~345. `formatUserResponse` therefore reports `permissions: []`, `canManageStock: false`
  and `hasAdminAccess: false` for every row in Manage Users, whatever is actually stored.
  Two consequences: the toggles always render as "not granted", and because
  `handleTogglePermission` in `ManageUsers.jsx` builds the new array from
  `user.permissions || []`, granting one capability **silently revokes every other capability
  that user held**. Adding `'permissions'` to the `attributes` array fixes both.
  Pre-existing, unrelated to this branch, and worth doing before Phase 2 builds on it.
- **`UserLoginLog.role` is `ENUM('doctor','staff','lab')`** — no `'nurse'` or `'admin'` value,
  so nurse logins are not recorded correctly and the Activity tab will look empty for them.
- **`User.createdBy` is a name string, not a user ID**, which contradicts the project
  audit-field rule. New tables use `INTEGER` referencing `Users.id`.
- **`CreateStaff.jsx` offers position "Nurse"** while creating a `role: 'staff'` account, so
  that person lands in the staff portal rather than the nurse portal. `CreateNurse.jsx` now
  exists for real nurses. Needs a decision — see §10 of the design doc.
- **Write access to the patient file has no proper permissions design yet.** As of the
  "Patient file read access" work below, every role that can reach a patient-file tab sees
  every write button on it (Upload Document, equipment Add/Edit/Replace, CareLink partner
  Add/Edit/Remove), but the backend endpoints behind them are still `doctor`/`staff` only —
  nurse and admin get a 403 if they use them. A gated version existed briefly on
  `fix/patient-profile-read-access` (button visibility matching the backend role list) and
  was deliberately reverted at the user's request, deferring this to a proper permissions
  pass rather than patching it button-by-button. That pass should also resolve: admin
  cannot write equipment or CareLink-partner records at all (`routes/patients.js`
  equipment/carelink-partners POST/PUT/DELETE are `doctor, staff` only — pre-existing, not
  introduced by that branch); and whether nurse should be able to upload documents.
- **The lab portal has no `patient-profile/:uhid` route.** Lab users cannot reach a patient
  file from their UI even though the API now allows the read (see below). Adding one needs
  a read-only portal config — the staff config it would fall through to has
  `canEditPatient: true`. Needs a decision.

---

## Completed

### Patient file read access — every internal role sees the whole record

- **Branch:** `fix/patient-profile-read-access` (both repos) — merged to `main`
- **Completed:** 2026-08-17
- **Reported as:** "staff can't read any doctor's notes on their portal, even the admin —
  when they look at a patient's file it doesn't display anything."

  Two independent causes, either of which alone produced a blank tab:

  1. **`GET /api/consultation-notes` was `authorize('doctor', 'staff')`** — no `admin`, no
     `nurse`. Admins and nurses got a 403 that `ConsultationNotesContext` turned into
     `{ notes: [] }`, so the tab rendered empty instead of erroring.
  2. **`ConsultationNotesList` filtered its read-only view to `n.date === today`** — so
     even for staff, who *were* authorised, nothing appeared unless a doctor had written
     a note that same day. The date was also `toISOString()` (UTC) against a backend
     `clinicToday()` (EAT), so the two disagreed until 03:00 local.

  Decision taken: reading a patient's record is no longer restricted by cadre. Every
  internal role (`doctor`, `staff`, `nurse`, `lab`, `admin`) may read every section of a
  patient file. `patient` is deliberately excluded: the patient portal is a separate trust
  boundary and doctors' notes are written on the understanding that patients do not read
  them.

Backend:
- `constants/permissions.js` — new `CLINICAL_READ_ROLES` constant, with the reasoning for
  why `patient` is not in it
- Applied to the GET routes behind every patient-file tab: consultation notes (list + by
  id), prescriptions (list, single, stats, top-drugs), documents (list + file), patients
  (list, vitals, vitals history, blood sugar, equipment ×3, care-link partners, diagnoses,
  chart metrics), GLP-1 administrations / reviews / week notes, appointments list,
  `queue/advised-referrals`, `admissions/advised`, `stock/patient-dispenses`, initial
  assessments, physical exams, treatment plans
- `admissions/advised` and `queue/advised-referrals` are uhid-scoped and feed the patient
  file, so they take the wider list; the ward-level admission reads keep the narrower
  inpatient `READ` list

Frontend:
- `ConsultationNotesList.jsx` — read-only view renders the full returned history (newest
  first, with assessment and plan) instead of only today's note, with a working "Load more
  notes" button instead of a dead-end "showing N of M"; distinct loading, failed and
  genuinely-empty states so a permission error can never again look like "no notes"; editor
  prefill date switched from UTC to local
- `PatientFile.jsx` — one shared `PATIENT_FILE_TABS` list for all portals. Doctor gains
  Doctor's Notes and Prescriptions; staff and admin gain Visit History. The doctor portal's
  `glycemic-charts` tab (which embedded the whole GlycemicCharts *page*, header and patient
  picker included) now uses `GlycemicChartPanel` like the other portals
- Prescriptions fetch no longer skips the doctor portal, which would have left its new tab
  empty

**Write access is unchanged throughout** — who may create a note, prescribe, upload a
document, or manage equipment is exactly as it was before this branch. See the two write-
access items in "Flagged, not fixed" above for what's still open there.

**Correction (2026-08-17, after merge to main):** the user flagged that staff should not
have gained read access to certain admin/doctor-only clinical data as a side effect of this
work — "some important things" staff shouldn't be viewing. Four endpoints reverted to their
exact pre-branch role lists, all on `main` directly since this branch was already merged:
- `GET /patients/:uhid/diagnoses` — back to `doctor` only (was briefly every internal role)
- `GET /patients/:uhid/chart-metrics` — back to `doctor` only (was briefly every internal role)
- `GET /assessments` (Initial Assessments) — back to `doctor, admin` (was briefly every role)
- `GET /physical-exams` — back to `doctor, admin` (was briefly every role)

Everything else this branch widened stays as merged — consultation notes, prescriptions,
documents, vitals, equipment, GLP-1, appointments, treatment plans, etc. — since staff
already had access to those before this branch in every case but these four. Net effect:
staff's Visit History tab silently loses the Initial Assessments and Physical Examinations
sections again (the context getters swallow the 403 into `[]`, same as before this branch
ever touched them) — this is the original, pre-existing behaviour, not a new gap. The
frontend admin-portal gate (`ProtectedRoute.jsx`, `requiredRole="admin"`) was never touched
by this branch and was not part of this correction — staff could not and still cannot
navigate to `/admin/*`.
