# Staff work — `feature/staff-profiles` vs `feat/staff-file`

**Date:** 2026-08-11
**Purpose:** review before deciding how to reconcile. Nothing has been merged.

Two branches solve overlapping problems:

| | `feature/staff-profiles` (ours) | `feat/staff-file` (emu11y) |
|---|---|---|
| Backend commits | 5 | 1 |
| Frontend commits | 4 | 7 |
| Backend files changed | 25 | 7 |
| Frontend files changed | 12 | 11 |

---

## 1. Scope side by side

| Capability | Ours | His |
|---|---|---|
| Per-staff file page with tabs | Yes | Yes |
| Documents | Yes | Yes |
| Permissions on the page | Yes | Yes |
| Activity | Yes | Yes |
| Inline editing | Yes | Yes (Overview) |
| Actions moved off Manage Users rows | Partly | Yes, fully |
| Profile schema consolidation | Yes | No |
| `employeeId` identifier | Yes | No |
| Demographics, emergency contact | Yes | No |
| Licence number / body / expiry on the profile | Yes | No |
| Employment status lifecycle | Yes | No |
| Audit fields on the profile | Yes | No |
| Nurses get a real profile | Yes | Partly — reads patched only |
| Leave tracking | Yes | No |
| Archive instead of delete for accounts | Yes | No |
| Document expiry dates | No | Yes |
| Document restore | No | Yes |
| Patient profile unification | No | Yes (out of scope for staff) |

---

## 2. Where we independently agreed

Worth noting, because it suggests the shape is right:

- A per-person file page rather than a modal
- Tabs: Overview, Documents, Permissions/Access, Activity
- A compact or collapsible header instead of a tall card
- Account actions belong on the file page, not on list rows
- Documents soft-archive rather than delete
- Files served through an authenticated route, never statically
- **A 60-day licence expiry warning** — we picked the same threshold separately
- Staff roles defined as `['doctor', 'staff', 'lab', 'nurse', 'admin']` — identical lists

---

## 3. Direct collisions

These are the merge blockers.

### 3.1 Two different `StaffDocuments` tables

| | Ours | His |
|---|---|---|
| Owner FK | `UserId` | `staffUserId` |
| Uploader FK | `uploadedById` | `uploadedById` |
| Category | `category` ENUM (10 values) | `documentCategory` STRING, validated in the controller against 6 values |
| Archive | `isArchived` BOOLEAN + `archivedById` | `status` ENUM('active','archived') + `archivedBy` STRING + `archiveReason` |
| Expiry | — | `expiryDate` DATEONLY |
| Visibility | `visibility` ENUM('Staff','Admin only') | — (admin-only throughout) |
| Files on disk | `uploads/staff-documents/` | `uploads/documents/` (shared with patients) |
| Migration | `20260811000005` | `20260811000001` |

**Both migrations guard on "does the table exist and return if so".** Whichever runs first creates the table; the second silently skips and records itself as successful. The controller that lost then queries columns that do not exist. This is exactly the failure we hit this week with `sequelize.sync()` racing the migrations — same shape, harder to spot, because migrate reports success.

### 3.2 Same files edited by both

`models/index.js`, `app.js`, `controllers/userController.js`, `App.jsx`, `ManageUsers.jsx`.

Ours rewrote `userController.js` heavily (four create paths collapsed to one, reads moved to `StaffProfile`). His made two small edits to the same function. Those two edits are already covered by our consolidation, so his hunks would conflict and then be redundant.

### 3.3 Different route conventions

| | Ours | His |
|---|---|---|
| Page URL | `/admin/staff-profile/:employeeId` | `/admin/staff/:id` (User PK) |
| Profile API | `GET /api/staff/:employeeId` | `GET /api/users/:id` |
| Documents API | `/api/staff/:employeeId/documents` (nested) | `/api/staff-documents?staffUserId=` (flat) |
| Permissions API | `PATCH /api/staff/:employeeId/permissions` | `PUT /api/users/:id` |

Ours resolves on `employeeId` deliberately, mirroring how patient routes resolve on `uhid` and keeping the database PK out of the URL. His has no `employeeId` to resolve on.

---

## 4. What his does better

Worth taking regardless of which branch becomes the base.

1. **`expiryDate` per document.** A practising licence *file* that lapses is a sharper model than a single `licenceExpiry` on the profile — someone can hold several certificates expiring on different dates. His Documents tab colours a row amber inside 60 days and red once past.
2. **Document restore.** Ours archives with no way back, which makes archiving feel risky. His has `PUT /:id/restore`.
3. **`archiveReason`.** Records *why*, which is the useful half.
4. **`ProfileTabBar` as a shared component.** Ours re-implements the tab strip inline. His extracts it, so the staff file and patient file cannot drift apart visually.
5. **He finished the Manage Users cleanup.** He removed the row action buttons entirely (−298 lines) now that the actions live on the file page. Ours left them in place, so the same actions exist in two places — and the row version still has the permissions bug noted below.

---

## 5. What ours does that his does not

1. **The schema work.** His branch adds documents on top of the existing three-table split, so nurses still borrow `StaffProfile` and still cannot hold a council registration number, a ward, or a cadre. His fix patches the *reads* (`formatUserResponse`, `getById` now accept `'nurse'`) — a real improvement, but the underlying record is still missing the fields.
2. **`employeeId`.** No staff identifier on his branch; URLs and lists use the database PK.
3. **Demographics and emergency contact.** Still discarded by `CreateStaff.jsx` on his branch.
4. **Leave.** Entirely absent, including the `DoctorBlock` wiring that stops a doctor on leave being booked.
5. **Employment status lifecycle** and archive-instead-of-delete for accounts.
6. **Staff self-service.** His routes are `authorize('admin')` throughout, so a staff member cannot see their own documents. Ours allows admin-or-self with a `visibility` flag so contracts and disciplinary letters stay admin-only.
7. **Separate upload directory.** His writes HR files into `uploads/documents` alongside patient medical documents. They are distinguishable in the database but not on disk, which matters for backup and retention policy.

---

## 6. Issues found — in both

### His

- **`serveFile` has no containment check.** `res.sendFile(path.resolve(document.filePath))` sends whatever path the row holds. The row is written by the app so this is not currently exploitable, and the route is admin-only, but a resolved-path check inside the upload directory costs two lines.
- **Files land in the patient document directory**, as above.
- **`documentCategory` is a STRING validated only in the controller.** Anything written by another code path bypasses the check; ours is an ENUM the database enforces.

### Ours

- **No document restore, no archive reason, no per-document expiry.** His are better here.
- **Manage Users row actions not removed**, so account actions now exist in two places.
- **Tab strip not extracted** into a shared component.

### Pre-existing, and neither branch fixes it

- **`activityLogService.TRACKED_ROLES` is `['staff', 'doctor', 'lab']`** — nurse and admin logins are never recorded at all. Combined with `UserLoginLog.role` being `ENUM('doctor','staff','lab')`, the Activity tab will be permanently empty for nurses on **both** branches. Root cause is the service, not either tab.
- **`listUsers` does not select the `permissions` column.** Manage Users therefore shows every capability as not granted, and because `handleTogglePermission` builds the next array from `user.permissions || []`, granting one capability silently revokes the others. His Permissions tab reads `staff.permissions` from `GET /users/:id`, which *does* return them — so his tab is correct while the list is wrong, and the two screens will disagree until this is fixed. One line: add `'permissions'` to the `attributes` array.

---

## 7. Options

**A. Ours as the base, port his improvements in.**
Keep the schema consolidation, `employeeId`, leave and access work; add `expiryDate`, `archiveReason`, document restore and `ProfileTabBar`; drop his `StaffDocuments` definition so there is one table. Finish his Manage Users cleanup.
*Most code kept, but his backend commit is effectively replaced — worth agreeing with him first.*

**B. His as the base, port ours on top.**
Our `StaffProfile` rewrite and five migrations would need redoing against his structure, and the leave work depends on `employeeId` routing that does not exist there. More rework for less benefit.

**C. Keep both, rename one table.**
Fastest merge, permanently two staff-document systems. Not recommended.

**D. Split by layer.**
His frontend (further along on Manage Users cleanup and component extraction), our backend (schema, leave, access). Sounds appealing, but his frontend calls `/api/users/:id` and `/api/staff-documents`, which our backend does not serve — so it is not a clean split.

---

## 8. Recommended

Option **A**, with the collaboration handled first:

1. Talk to emu11y before either branch merges — two people have now built the same feature twice, and that is the more expensive problem than the code.
2. Fix the two pre-existing bugs in §6 on their own small branch, since both branches depend on them and neither owns them.
3. Reconcile the document tables into one definition, taking his `expiryDate`, `archiveReason` and restore, and our `visibility`, separate directory and ENUM category.
4. Adopt his `ProfileTabBar` and finish the Manage Users row cleanup.
5. Leave his `PatientFile` unification alone — it is genuinely useful but unrelated, and it should be reviewed on its own.
