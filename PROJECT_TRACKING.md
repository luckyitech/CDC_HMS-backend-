# CDC HMS — Project Tracking

Running record of features, fixes and significant changes. A task is only marked
`Completed` once it has been implemented **and** tested, with the completion date recorded.

---

## In Progress

### Staff Profiles (doctor / nurse / lab tech / staff)

- **Branch:** `feature/staff-profiles`
- **Status:** Phase 1 implemented — **awaiting testing against a real database**
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

**Verification done so far:** all changed files parse; the Express app boots; the eight
`/api/staff` routes are mounted and reject unauthenticated requests; ESLint clean; 13 unit
assertions pass covering employee-ID generation, the audit diff and licence-expiry derivation.
**Not yet done:** running the migrations against a real MySQL database, and manual testing of
the page. The sandbox has no MySQL and the installed `node_modules` are Windows binaries, so
neither could be verified here.

#### Phase 2 — access *(not started)*

Permission list, editable role bundles, Access tab, `requirePermission` on selected endpoints.

#### Phase 3 — leave and documents *(not started)*

`StaffLeaves`, `LeaveBalances`, `StaffDocuments`, `DoctorBlock` wiring, staff self-service.

- **Next step:** run the three migrations on a copy of production data, confirm the backfill
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

---

## Completed

_(nothing recorded yet — this file was introduced on 2026-08-11)_
