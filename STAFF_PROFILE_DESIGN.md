# Staff Profile — Design Document

**Status:** Draft — for review, not implemented
**Branch:** `feature/staff-profiles`
**Date:** 2026-08-11

---

## 1. What we are building

An admin page for a single member of staff — the same page pattern the team already uses for
patients, with staff content instead.

Patients have `/staff/patient-profile/CDC002` rendered by `StaffPatientProfile.jsx`.
Staff get `/admin/staff-profile/EMP014`, built from the same layout so it looks and behaves
identically to what everyone already knows.

From that page an admin can see who someone is, control what they can access, track their
leave, hold their documents, and see what they have been doing.

This covers all four cadres: **doctor**, **nurse**, **lab tech** and the **`staff`** role
(front desk / admission clerks / receptionists).

### Layout mapping

| Patient profile | Staff profile |
|---|---|
| `PageHeader` + tall avatar `Card` (~260px of header) | One compact header row, ~70px |
| Name + UHID | Name + employee ID |
| Pills: diagnosis, risk level, status | Pills: account status, licence warning |
| Tabs: Overview, Notes, Prescriptions, Charts, Equipment, Documents | Tabs: Overview, Credentials, Access, Leave, Documents, Activity |
| Edit Profile button + modal | Same, plus an overflow menu |

Start by copying `pages/staff/StaffPatientProfile.jsx` for the tab strip, data loading and
responsive behaviour — but **not** its header. See below.

---

## 2. The tabs

### Header (always visible)

A single compact row with the tab strip attached directly beneath it — **no `PageHeader`, no
avatar card**. The patient profile's header stack costs around 260px before any content appears;
this one is about 70px. On a page whose job is dense administrative data, that height was being
spent on whitespace.

Left to right:

- 34px avatar (photo, or the initial on a tinted circle)
- Name, with the employee ID beside it in muted text
- One line of metadata beneath: role · department · employment type · joined
- Status pills: account status, and a licence expiry warning when one is approaching
- **Edit** button, then an overflow menu (`⋮`) holding Reset password, Activate/Deactivate,
  and Back to users

Then the tab strip, underlined-active style, sitting on a hairline border.

Deliberately **not** in the header: the page title (the breadcrumb already says where you are),
and email (it lives in the Overview tab — phone is the one people need at a glance).

The pill row is the part doing real work: it changes per person, so an admin scanning profiles
sees a problem without opening a tab. A front-desk member has no licence, so no licence pill —
not an empty one.

### Overview

Three cards, matching the shape of the patient overview:

- **Personal** — date of birth, gender, national ID, address, city
- **Employment** — position, department, ward/unit, shift, employment type, date joined, reports to
- **Emergency contact** — name, relationship, phone

### Credentials

Licence number, issuing body, expiry date, specialty. Qualifications (degree, institution, year).
Years of experience. Certifications — BLS/ACLS/ICU for nurses, equipment competencies for lab techs.

**This tab hides itself for `role: 'staff'`.** Front desk hold no clinical licence, and showing
four permanently empty fields is noise.

### Access

Role, assigned permission bundles, individual permission toggles, and account state (active,
password last changed). This is where the permission toggles currently living in
`ManageUsers.jsx` move to — they are settings, not one-off actions.

**Archive** sits at the bottom of this tab, separated, with a confirmation dialog. See §3.5.

### Leave

Balance for the current year at the top — entitlement, taken, remaining. Below it the history:
dates, type, days, status, who approved. Plus a "record leave" action for the admin.

### Documents

Upload with a category. Lists filename, category, size, uploader, date. Some categories are
admin-only — see §3.4.

### Activity

Login history and edit history, from the existing `UserLoginLog` and `UserEditLog` tables. Mostly
display work. Answers "who changed this person's permissions, and when."

---

## 3. Data model

### 3.1 What exists today

`User` holds auth and identity; role-specific detail sits in one table per role, joined by
`User.hasOne(X)` (which creates the `UserId` FK column):

| Model | Fields today |
|---|---|
| `User` | email, password, role, firstName, lastName, phone, isActive, resetToken, resetTokenExpires, createdBy, passwordChangedAt, canManageStock *(superseded)*, permissions |
| `DoctorProfile` | licenseNumber, specialty, subSpecialty, department, qualification, medicalSchool, yearsExperience, employmentType, startDate, address, city |
| `StaffProfile` | position, department, shift, startDate |
| `LabTechProfile` | specialization, certificationNumber, qualification, institution, yearsExperience, shift, startDate |

`User.role` is `ENUM('doctor','staff','lab','patient','admin','nurse')`.

Creation endpoints (admin-only, all in `controllers/userController.js`, each in a transaction so
`User` and profile commit together):

- `POST /api/users/doctors` → `DoctorProfile`
- `POST /api/users/staff` → `StaffProfile`
- `POST /api/users/nurses` → **`StaffProfile`** with `position` defaulting to `'Nurse'`
- `POST /api/users/lab-techs` → `LabTechProfile`

**Gaps this design closes:**

1. **Nurses have no profile table** — they borrow `StaffProfile`, so no nursing council number,
   no ward, no cadre, no certifications.
2. **No staff identifier.** Patients get `uhid` (`CDC001`, unique index). Staff have only a PK
   and email — nothing for a badge, a prescription footer, or a search box.
3. **No demographics or emergency contact.** Address and city exist on doctors only.
4. **Status is a boolean.** `isActive` cannot express On Leave / Suspended / Resigned.
5. **`CreateStaff.jsx` already collects data the backend throws away.** The form holds
   `dateOfBirth`, `gender`, `idNumber`, `address`, `city`, `emergencyContact`, `emergencyPhone`
   and `employmentType`; its submit handler sends none of them. The admin types them in, the form
   clears, and they are gone — there is nowhere to put them.
6. **`shift` is hardcoded to `'Morning'`** in that same handler, because `routes/users.js`
   requires the field while the form's shift dropdown is commented out. Every staff member in the
   database is on the morning shift regardless of reality.
7. **Duplication and drift** — department/shift/startDate/qualification/yearsExperience repeat
   across three tables, and the same idea is `specialty` on doctors but `specialization` on lab techs.

### 3.2 `StaffProfile` — consolidated

All three profile tables merge into one, holding shared fields as real columns plus a
`roleDetails` JSON column for the role-specific part. This mirrors `Patient`, which already mixes
typed columns with JSON (`comorbidities`, `emergencyContact`, `insurance`, `chartMetrics`).

```js
// models/StaffProfile.js
const StaffProfile = defineModel('StaffProfile', {
  // UserId added automatically by User.hasOne(StaffProfile) in models/index.js

  // --- Identity ---
  employeeId:    { type: DataTypes.STRING, allowNull: false },   // EMP001 — unique index
  dateOfBirth:   { type: DataTypes.DATE },
  gender:        { type: DataTypes.ENUM('Male', 'Female', 'Other') },
  idNumber:      { type: DataTypes.STRING },
  photoUrl:      { type: DataTypes.STRING },

  // --- Contact ---
  address:          { type: DataTypes.STRING },
  city:             { type: DataTypes.STRING },
  emergencyContact: { type: DataTypes.JSON, defaultValue: null },  // { name, relationship, phone }

  // --- Employment ---
  position:       { type: DataTypes.STRING },
  department:     { type: DataTypes.STRING },
  ward:           { type: DataTypes.STRING },
  employmentType: { type: DataTypes.ENUM('Full-time','Part-time','Contract','Consultant','Locum') },
  shift:          { type: DataTypes.STRING },
  startDate:      { type: DataTypes.DATE },
  endDate:        { type: DataTypes.DATE },
  employmentStatus: {
    type: DataTypes.ENUM('Active','On Leave','Suspended','Resigned','Terminated'),
    defaultValue: 'Active',
  },
  reportsToId:    { type: DataTypes.INTEGER },   // Users.id

  // --- Credentials (same shape across doctor / nurse / lab) ---
  licenseNumber:   { type: DataTypes.STRING },
  licenseBody:     { type: DataTypes.STRING },
  licenseExpiry:   { type: DataTypes.DATE },
  specialty:       { type: DataTypes.STRING },
  qualification:   { type: DataTypes.STRING },
  institution:     { type: DataTypes.STRING },
  yearsExperience: { type: DataTypes.INTEGER },

  // --- Role-specific ---
  roleDetails:   { type: DataTypes.JSON, defaultValue: {} },

  // --- Accountability ---
  createdBy:  { type: DataTypes.INTEGER },
  updatedBy:  { type: DataTypes.INTEGER },
  deletedAt:  { type: DataTypes.DATE },
  deletedBy:  { type: DataTypes.INTEGER },
}, {
  indexes: [{ unique: true, fields: ['employeeId'], name: 'unique_employee_id' }],
});
```

`createdAt` / `updatedAt` come from Sequelize timestamps as everywhere else.

**Note on `createdBy`:** `User.createdBy` is a `STRING` holding `req.user.name`. The project audit
rule says use the authenticated user's **ID**, so the new columns are `INTEGER` referencing
`Users.id`. `User.createdBy` is left alone — flagged, not silently changed.

**`roleDetails` by role:**

| Role | Keys |
|---|---|
| doctor | `subSpecialty`, `consultationFee`, `acceptsAppointments`, `signatureUrl`, `qualifications` (array of `{degree, institution, year}`) |
| nurse | `nursingCadre` (RN / EN / Midwife), `certifications` (array), `wardRotation` |
| lab | `labSection`, `equipmentCompetencies` (array), `supervisingPathologistId` |
| staff | `desk` (Front Desk / Records / Billing / Admissions), `dutyPoints` (array) |

Rule of thumb: if it is queried, filtered or listed, it is a column. If it is only ever displayed
on the profile page, it goes in `roleDetails`.

For `role: 'staff'` the whole credentials block stays null — that is the point of one shared
table. Null columns beat a table they do not fit into.

### 3.3 `employeeId`

Add `generateEmployeeId` to `utils/generateId.js`, following `generateUHID`'s numeric-max approach
(which already avoids the string-sort bug documented in `generateNumber`). Format `EMP001`,
`EMP002`. Called inside the existing create transactions so a failed create does not burn an ID.

### 3.4 Leave and documents

```
StaffLeaves       — id, UserId, leaveType, startDate, endDate, days, reason,
                    status ('Pending'|'Approved'|'Rejected'|'Cancelled'),
                    approvedById, approvedAt, rejectionReason,
                    doctorBlockIds (JSON — see below), + audit fields

LeaveBalances     — id, UserId, year, leaveType, entitled, taken, carriedOver, + audit fields

StaffDocuments    — id, UserId, documentId (unique), category, fileName, filePath,
                    fileSize, fileUrl, visibility ('Staff'|'Admin only'),
                    uploadedById, uploadedByRole, notes,
                    isArchived, archivedBy, archivedAt, + audit fields
```

`StaffDocument` deliberately mirrors `MedicalDocument` — unique `documentId`, the same file
fields, the same archive-rather-than-delete columns. Two things are deliberately **not** shared
with the patient store:

- **A separate table.** Staff HR files in `MedicalDocuments` would surface in patient document
  listings and inherit patient access rules. Wrong on both counts.
- **A separate directory**, `uploads/staff-documents`, alongside the existing
  `uploads/documents`.

Reuse `middleware/upload.js`'s approach — multer, uuid filenames, extension **and** MIME
validation, 25MB cap, files served through an authenticated route rather than statically. It
needs a second multer instance pointed at the new directory, and its `fileFilter` extended to
accept `.docx` for contracts (with the matching MIME type — the spoofing check is the point of
that filter).

Categories: employment contract, national ID copy, practising licence, academic certificates, CV,
training certificates, sick notes. `visibility` keeps contracts and disciplinary letters
admin-only while the staff member sees the rest.

**Leave rules:**

- Admin approves. Leave does **not** block login — being on annual leave should not lock someone
  out; that is what Suspended is for.
- Approving leave for a doctor **writes `DoctorBlock` rows** for the leave period, so reception
  cannot book someone who is away. The created IDs are stored on the leave record so cancelling
  the leave removes them again.
- `employmentStatus` moves to `'On Leave'` for the duration and back to `'Active'` afterwards.

### 3.5 Archive, not delete

`userController.deleteUser` currently destroys the user and their profile row. On a profile page
that also leaves the admin standing on a dead URL.

Change it to archive: set `deletedAt` / `deletedBy`, set `isActive = false`, drop the record out
of lists, redirect back to Manage Users. The record stays because a departed doctor's name is
still attached to prescriptions, consultation notes and lab results — hard-deleting them breaks
that history.

True deletion stays available to a real admin for genuine mistakes (a duplicate account created
minutes ago), not as the normal exit path.

---

## 4. Access control

### 4.1 What exists

`constants/permissions.js` is already well built and designed to grow — its own comment says
adding a capability "costs a string here, not a migration."

- `PERMISSIONS` = `admin.access`, `stock.manage`
- `permissions` is a JSON array column on `User`, default `[]`
- `PERMISSIBLE_ROLES = ['doctor','staff','lab','nurse']` — patients excluded outright
- A real admin implicitly holds every permission
- `authenticate` reads role **and** permissions from the database on every request, not from the
  JWT — so a revoke takes effect on the next request, not the next login
- `authorize(...roles)` gates endpoints by role (~34 call sites); `requirePermission(p)` gates by
  capability; `requireTrueAdmin` reserves granting to a real admin account so the capability
  cannot spread and become unrevocable

**The ceiling:** it is additive only. `authorize('staff')` admits *every* staff user, so you
cannot say "this receptionist may register patients but not run triage."

### 4.2 The approach — opt-in restriction

`effectivePermissions(user)` in `constants/permissions.js` is the single function that answers
"what can this person do." Widening what it looks at is the whole job — the signature and every
caller stay the same.

**Step 1 — fill out the permission list.** Pure addition, no migration. Add module capabilities to
`PERMISSIONS`: `patients.manage`, `queue.manage`, `triage.record`, `appointments.manage`,
`admissions.manage`, `lab.manage`, `billing.manage`, `reports.view`, `inpatient.manage`, alongside
the existing two. Nothing enforces them yet — this just creates the vocabulary.

**Step 2 — roles become editable bundles.** Do **not** change what `User.role` does; it picks the
profile shape and the portal, and it is identity. Add a separate table for access:

```
Roles      — id, name, description, permissions (JSON), isSystem, + audit fields
UserRoles  — UserId, RoleId
```

Seed system rows matching today's behaviour — Doctor, Nurse, Lab Technician, Front Desk — each
carrying the permissions that role implicitly has now. An admin can then create "Records Clerk"
without a migration. `isSystem` stops someone deleting "Doctor" and orphaning every doctor.

`effectivePermissions` becomes: admin → everything; otherwise the union of every assigned role's
permissions plus the user's own `permissions` array. Direct grants keep working exactly as today.

**Step 3 — enforce, endpoint by endpoint.** Leave `authorize()` in place as the coarse gate and
add `requirePermission()` beside it where per-person control is wanted:

```js
router.post('/', authenticate, authorize('staff','admin'),
  requirePermission(PERMISSIONS.PATIENTS_MANAGE), patientController.create);
```

Convert only the endpoints that need it. Anything unconverted behaves exactly as before — there is
no flag day where everyone's access changes at once. Frontend follows: `/api/auth/me` returns the
permission list and the sidebar hides what the user cannot reach. The backend still enforces; the
hiding is convenience, not security.

**Step 4 — memberships (later).** `Ward` is already a model and `department` is on every profile,
but neither means anything for access today.

```
StaffGroups        — id, name, type ('Department'|'Ward'|'Team'), permissions (JSON)
StaffGroupMembers  — GroupId, UserId, isLead, joinedAt, leftAt
```

Add someone to "Front Desk" and they inherit its permissions; remove them and it is gone. One more
term in the same union. The payoff is onboarding — one group assignment instead of twelve toggles.

**Not planned:** ward-scoped access ("this nurse sees only her ward's patients"). That is a
different shape of problem — it needs the record passed into the check, not just the user, and it
touches every patient-facing query. Separate project, only if the hospital requires it.

### 4.3 Shared action handlers

`handleTogglePermission`, `handleResetPassword`, `handleToggleStatus` and `handleDelete` currently
live inside `ManageUsers.jsx`. The profile page needs the same behaviour. Pull them into a shared
hook both pages import, so the list view and the detail view cannot drift apart.

---

## 5. API surface

Keep the four existing create endpoints — their validators differ per role and `ManageUsers.jsx`
already calls them. They write to `StaffProfile` instead of three different tables. Add:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/staff` | admin | List / search — filter by role, department, ward, status |
| `GET` | `/api/staff/:employeeId` | admin, self | Full profile |
| `PUT` | `/api/staff/:employeeId` | admin | Update; writes `UserEditLog` |
| `PATCH` | `/api/staff/:employeeId/status` | admin | Change `employmentStatus`, syncs `isActive` |
| `DELETE` | `/api/staff/:employeeId` | admin | Archive (see §3.5) |
| `GET` | `/api/staff/expiring-licences` | admin | Licences expiring within 60 days |
| `GET`/`POST` | `/api/staff/:employeeId/leaves` | admin, self | List / request leave |
| `PATCH` | `/api/staff/:employeeId/leaves/:id` | admin | Approve, reject, cancel |
| `GET`/`POST` | `/api/staff/:employeeId/documents` | admin, self | List / upload |
| `DELETE` | `/api/staff/:employeeId/documents/:id` | admin | Archive a document |
| `GET` | `/api/staff/:employeeId/activity` | admin | Login + edit history |

A `findStaff` middleware mirroring `middleware/findPatient.js` resolves `:employeeId` and attaches
the record, keeping controllers thin.

New controllers rather than growing `userController.js`, which is already large and carries four
create paths: `staffController.js`, `leaveController.js`, `staffDocumentController.js`.

**`employmentStatus` vs `isActive`:** `isActive` stays the single source of truth for whether login
is permitted; `employmentStatus` is the HR-facing detail. Anything other than Active or On Leave
sets `isActive = false`. Both written in the same transaction so they cannot drift.

---

## 6. Migration plan

Guarded migrations, following the `tableExists` pattern in
`migrations/20260807000009-create-inpatient-observations.js`.

1. **`add-fields-to-staff-profiles`** — add all new columns, nullable.
2. **`backfill-staff-profiles`** — for every doctor/lab user without a `StaffProfile` row, create
   one:
   - doctor: `licenseNumber`→`licenseNumber`, `specialty`→`specialty`,
     `medicalSchool`→`institution`, `subSpecialty`→`roleDetails.subSpecialty`; department,
     qualification, yearsExperience, employmentType, startDate, address, city map 1:1
   - lab: `certificationNumber`→`licenseNumber`, `specialization`→`specialty`,
     `institution`→`institution`; shift, qualification, yearsExperience, startDate 1:1
   - existing staff/nurse rows: set `employmentType = 'Full-time'` where null
3. **`backfill-employee-ids`** — assign `EMP###` in `createdAt` order, then add the unique index.
4. **`create-roles-and-user-roles`** + seed system roles.
5. **`create-staff-leaves-and-balances`**
6. **`create-staff-documents`**
7. **Deprecate, do not drop.** `DoctorProfile` and `LabTechProfile` stay in the codebase for one
   release, no longer written to. A later migration drops them once the new path is confirmed in
   production.

Reads that currently join `DoctorProfile` must move in the same release as step 2:
`appointmentController.js` (~36, 62, 292), `prescriptionController.js` (~36, 64),
`publicBookingController.js` (~48, 55, 240), `userController.js` (~445–462, 508–510, 704–708,
754–758, 794–801), `authController.js` (~11–19).

---

## 7. Frontend

New `src/pages/admin/StaffProfile.jsx`. Take the tab strip, data loading and responsive
behaviour from `pages/staff/StaffPatientProfile.jsx`, but build the compact header described in
§2 rather than reusing `PageHeader` + avatar card. Route `admin/staff-profile/:employeeId` in
`App.jsx`, lazy-loaded like its neighbours.
`ManageUsers.jsx` rows link to it. The page is role-aware — the Credentials tab hides itself for
`role: 'staff'`.

The create pages gain the new fields but keep their structure. **`CreateStaff.jsx` needs the least
work** — its form state already holds every identity and contact field; the submit handler just
has to stop dropping them, and `routes/users.js` has to accept them. Do that in the same commit as
the schema change so the fields go live the moment the columns exist. Also uncomment its shift
dropdown and stop hardcoding `'Morning'`.

> **Pre-existing issue, flagged not fixed:** `UserLoginLog.role` is `ENUM('doctor','staff','lab')`
> — no `'nurse'` or `'admin'` value, so nurse logins are not recorded correctly. The Activity tab
> will look empty for nurses until that enum is widened. Separate fix, separate branch.

---

## 8. Phasing

**Phase 1 — the record and the page.** `StaffProfile` schema, migrations 1–3,
`generateEmployeeId`, `staffController` + `findStaff`, the profile page with Overview,
Credentials and Activity tabs, `CreateStaff.jsx` fixes, archive instead of delete.
Ships and gets tested on its own.

**Phase 2 — access.** Permission list, `Roles` + `UserRoles`, `effectivePermissions` widened, the
Access tab, shared action handlers, `requirePermission` added to the first batch of endpoints.

**Phase 3 — leave and documents.** `StaffLeaves`, `LeaveBalances`, `StaffDocuments`, the second
multer instance, `DoctorBlock` wiring, the Leave and Documents tabs, and staff self-service so
people can upload their own files and request their own leave.

---

## 9. Out of scope

Decided against, deliberately, so they do not creep back in unnoticed:

- **Performance / activity metrics.** `getDoctorPerformance` and `getStaffTriagePerformance`
  already exist in `analyticsController.js` and could be filtered per person later. Parked.
- **Payroll** — salary, bank details, tax/NHIF/NSSF numbers. Parked.
- **Attendance / clock-in.** A much larger feature than leave. Not planned.
- **Occupational health** — immunisation status, pre-employment screening. Keeping health data
  off the staff record means it does not inherit patient-grade access rules.
- **Ward-scoped access.** See §4.2.

---

## 10. Open questions

1. `employeeId` format — `EMP001`, or year-scoped `EMP-2026-001` like the RX/LAB numbers?
2. Which leave types does the hospital recognise, and what is the entitlement for each?
3. Does an expiring licence only warn on the dashboard, or should it block the doctor from
   signing prescriptions?
4. `reportsToId` — is the reporting line used operationally, or decorative? If decorative, drop it.
5. `CreateStaff.jsx` offers position "Nurse" while creating a `role: 'staff'` account, and
   `CreateNurse.jsx` now exists creating `role: 'nurse'`. Should "Nurse" be removed from the staff
   position list, or are there non-clinical staff genuinely titled Nurse?

---

## 11. Implementation checklist

**Phase 1** — implemented 2026-08-11, **not yet tested against a database**

- [x] Rewrite `models/StaffProfile.js`
- [x] Migrations 1–3 (guarded, and safe on a fresh `sequelize.sync()` database)
- [x] `generateEmployeeId` in `utils/generateId.js`
- [x] `middleware/findStaff.js`, `controllers/staffController.js`, `routes/staff.js`
- [x] Update the `DoctorProfile` joins listed in §6
- [x] Archive instead of delete in `userController.deleteUser`
- [x] `StaffProfile.jsx` + route + `ManageUsers` links
- [x] `CreateStaff.jsx`: send the fields it already collects; real shift dropdown
- [x] Extend the other create forms
- [ ] **Run the migrations against a copy of production data**
- [ ] **Manual test of the profile page**
- [ ] Then record in `PROJECT_TRACKING.md` with the completion date

**Phase 2**

- [ ] Extend `PERMISSIONS`
- [ ] `Roles` + `UserRoles` models, migration, system-role seed
- [ ] Widen `effectivePermissions`
- [ ] Shared action-handler hook, used by both `ManageUsers` and `StaffProfile`
- [ ] Access tab
- [ ] `requirePermission` on the first batch of endpoints
- [ ] Permission-aware sidebar

**Phase 3**

- [ ] `StaffLeaves`, `LeaveBalances`, `StaffDocuments` models + migrations
- [ ] `leaveController.js`, `staffDocumentController.js`
- [ ] Second multer instance → `uploads/staff-documents`, `.docx` allowed
- [ ] `DoctorBlock` wiring on leave approval and cancellation
- [ ] Leave and Documents tabs
- [ ] Staff self-service profile page
