const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, hasPermission, canOpenPortal,
  sanitizePermissions, sanitizeDeniedPermissions,
} = require('../constants/permissions');
const { authorize } = require('../middleware/auth');

// =====================================================================
// authorize() accepts capabilities alongside roles: an argument containing a
// dot is checked as a permission, so a route reads "these roles, OR anyone
// granted this capability".
//
// No database — authorize() only reads req.user, so plain objects are enough.
// This is the seam the whole permissions model grows on (PERMISSIONS-MODEL.md),
// so its edges are worth pinning down.
// =====================================================================

// Minimal express double — the middleware only calls next() or res.status().json().
const run = (middleware, user) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware({ user }, res, () => resolve({ allowed: true }));
});

const user = (role, permissions = []) => ({ role, permissions });

describe('authorize() — roles and capabilities in one list', () => {
  const GATE = ['doctor', 'nurse', 'inpatient.access'];

  test('admits a listed role', async () => {
    assert.equal((await run(authorize(...GATE), user('doctor'))).allowed, true);
    assert.equal((await run(authorize(...GATE), user('nurse'))).allowed, true);
  });

  test('admits an unlisted role holding the capability', async () => {
    const granted = user('staff', [PERMISSIONS.INPATIENT_ACCESS]);
    assert.equal((await run(authorize(...GATE), granted)).allowed, true);
  });

  test('refuses an unlisted role without the capability', async () => {
    const res = await run(authorize(...GATE), user('staff'));
    assert.equal(res.allowed, false);
    assert.equal(res.code, 403);
  });

  test('a capability does not leak across capabilities', async () => {
    // stock.access must not open an inpatient.access gate.
    const stockOnly = user('staff', [PERMISSIONS.STOCK_ACCESS]);
    assert.equal((await run(authorize(...GATE), stockOnly)).allowed, false);
  });

  test('role-only gates are unaffected by the change', async () => {
    assert.equal((await run(authorize('doctor'), user('doctor'))).allowed, true);
    assert.equal((await run(authorize('doctor'), user('nurse'))).allowed, false);
    // A capability a role-only gate never mentions must not admit.
    const granted = user('staff', [PERMISSIONS.INPATIENT_ACCESS]);
    assert.equal((await run(authorize('doctor'), granted)).allowed, false);
  });
});

describe('advised-referrals is readable by the roles that render Visit History', () => {
  // GET /api/queue/advised-referrals feeds VisitHistoryPanel, which the admin
  // portal renders at /admin/patient-profile/:uhid. Admin was missing from this
  // gate, and the frontend's .catch swallowed the 403 — an admin saw admission
  // notes but silently lost referral notes. Pinned so it cannot regress.
  const GATE = ['staff', 'doctor', 'nurse', 'admin'];

  for (const role of GATE) {
    test(`${role} may read referral notes`, async () => {
      assert.equal((await run(authorize(...GATE), user(role))).allowed, true);
    });
  }

  test('a patient may not', async () => {
    assert.equal((await run(authorize(...GATE), user('patient'))).allowed, false);
  });
});

// =====================================================================
// Withdrawals — the restrictive half of the per-staff permissions tab.
//
// A grant adds to what a role allows. A withdrawal subtracts from it, so an
// admin can hold one person out of a section their role would otherwise open.
// These are the rules that keep that from becoming a footgun.
// =====================================================================

const denied = (role, deniedPermissions = [], permissions = []) =>
  ({ role, permissions, deniedPermissions });

describe('a withdrawn capability is refused even when the role allows it', () => {
  const GATE = ['doctor', 'nurse', 'staff', 'admin', 'inpatient.access'];

  test('a staff member whose role admits them is still refused once withdrawn', async () => {
    const res = await run(authorize(...GATE), denied('staff', [PERMISSIONS.INPATIENT_ACCESS]));
    assert.equal(res.allowed, false, 'the withdrawal must beat the role');
    assert.equal(res.code, 403);
  });

  test('the same person is admitted with nothing withdrawn', async () => {
    assert.equal((await run(authorize(...GATE), user('staff'))).allowed, true);
  });

  test('a withdrawal beats an explicit grant of the same capability', async () => {
    // Both lists naming the same capability is a contradiction the API refuses
    // to store, but the middleware must not depend on that having been enforced.
    const both = denied('lab', [PERMISSIONS.INPATIENT_ACCESS], [PERMISSIONS.INPATIENT_ACCESS]);
    assert.equal((await run(authorize(...GATE), both)).allowed, false);
  });

  test('a real admin account cannot be withdrawn from', async () => {
    // Otherwise an administrator could lock the last administrator out of the
    // very screen that grants permissions, with no way back through the UI.
    const res = await run(authorize(...GATE), denied('admin', [PERMISSIONS.INPATIENT_ACCESS]));
    assert.equal(res.allowed, true);
  });

  test('withdrawing one capability does not touch another', async () => {
    const u = denied('staff', [PERMISSIONS.INPATIENT_ACCESS], [PERMISSIONS.STOCK_ACCESS]);
    assert.equal(hasPermission(u, PERMISSIONS.STOCK_ACCESS), true);
    assert.equal(hasPermission(u, PERMISSIONS.INPATIENT_ACCESS), false);
  });

  test('a role-only gate is NOT deniable', async () => {
    // Only sections whose capability appears in the gate can be withdrawn.
    // Otherwise every hardcoded clinical role list would silently become
    // something an admin could switch off.
    const res = await run(authorize('doctor'), denied('doctor', [PERMISSIONS.INPATIENT_ACCESS]));
    assert.equal(res.allowed, true);
  });

  test('a granted admin.access can be withdrawn again', async () => {
    const revoked = denied('staff', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal((await run(authorize('admin'), revoked)).allowed, false);
  });
});

describe('the stock split keeps every existing holder whole', () => {
  test("a row still saying 'stock.manage' resolves to both halves", () => {
    // Rows written before the split, and any environment brought up by
    // sequelize.sync() rather than the migration.
    const legacy = user('staff', ['stock.manage']);
    assert.equal(hasPermission(legacy, PERMISSIONS.STOCK_ACCESS), true);
    assert.equal(hasPermission(legacy, PERMISSIONS.STOCK_WRITE), true);
  });

  test('granting the write carries the access it acts within', () => {
    assert.deepEqual(
      sanitizePermissions([PERMISSIONS.STOCK_WRITE]),
      [PERMISSIONS.STOCK_ACCESS, PERMISSIONS.STOCK_WRITE],
      'a write with no access is a state no screen can show and no gate expects'
    );
  });

  test('access alone is a real state — read-only stock', () => {
    const readOnly = user('staff', [PERMISSIONS.STOCK_ACCESS]);
    assert.equal(hasPermission(readOnly, PERMISSIONS.STOCK_ACCESS), true);
    assert.equal(hasPermission(readOnly, PERMISSIONS.STOCK_WRITE), false);
  });

  test('withdrawing a section withdraws the ability to act in it', () => {
    assert.deepEqual(
      sanitizeDeniedPermissions([PERMISSIONS.INPATIENT_ACCESS]),
      [PERMISSIONS.INPATIENT_ACCESS, PERMISSIONS.INPATIENT_WRITE],
      'or a withdrawn user would still reach the write routes'
    );
  });
});

// =====================================================================
// Portal entry.
//
// 'admin.access' used to open every portal at once. Each portal is now granted
// separately, so someone can be trusted with the lab without being trusted with
// user management. A role still opens its own portal with nothing granted.
// =====================================================================

describe('portal entry is granted per portal', () => {
  const at = (role, perms = [], deniedPermissions = []) =>
    ({ role, permissions: perms, deniedPermissions });

  test("a role opens its own portal with nothing granted", () => {
    assert.equal(canOpenPortal(at('doctor'), PERMISSIONS.PORTAL_DOCTOR), true);
    assert.equal(canOpenPortal(at('lab'), PERMISSIONS.PORTAL_LAB), true);
    assert.equal(canOpenPortal(at('staff'), PERMISSIONS.PORTAL_STAFF), true);
  });

  test('and not somebody else\'s', () => {
    assert.equal(canOpenPortal(at('doctor'), PERMISSIONS.PORTAL_LAB), false);
    assert.equal(canOpenPortal(at('lab'), PERMISSIONS.PORTAL_ADMIN), false);
  });

  test('a grant opens exactly one portal, not all of them', () => {
    const doctorWithLab = at('doctor', [PERMISSIONS.PORTAL_LAB]);
    assert.equal(canOpenPortal(doctorWithLab, PERMISSIONS.PORTAL_LAB), true);
    assert.equal(canOpenPortal(doctorWithLab, PERMISSIONS.PORTAL_ADMIN), false,
      'this is the whole point of the change — one grant must not open the rest');
    assert.equal(canOpenPortal(doctorWithLab, PERMISSIONS.PORTAL_STAFF), false);
  });

  test('admin.access alone no longer opens every portal', () => {
    // Before this feature it did. The migration grants the portals explicitly to
    // everyone who held it, so nobody loses access at deploy — but the
    // capability itself must not carry them any more.
    const granted = at('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal(canOpenPortal(granted, PERMISSIONS.PORTAL_LAB), false);
    assert.equal(canOpenPortal(granted, PERMISSIONS.PORTAL_STAFF), false);
  });

  test('a withdrawal beats the role default — even for their own portal', () => {
    const shutOut = at('doctor', [], [PERMISSIONS.PORTAL_DOCTOR]);
    assert.equal(canOpenPortal(shutOut, PERMISSIONS.PORTAL_DOCTOR), false);
  });

  test('a real admin account opens every portal and cannot be shut out', () => {
    const admin = at('admin', [], [PERMISSIONS.PORTAL_LAB, PERMISSIONS.PORTAL_ADMIN]);
    assert.equal(canOpenPortal(admin, PERMISSIONS.PORTAL_LAB), true);
    assert.equal(canOpenPortal(admin, PERMISSIONS.PORTAL_ADMIN), true);
  });

  test('opening the admin portal does NOT hand over administrator powers', () => {
    // This implication used to exist, on the reasoning that an admin portal you
    // cannot use is pointless. It was wrong once the narrow admin capabilities
    // arrived: it made "the admin portal, but only Monitoring" impossible to
    // express, because opening the door quietly granted everything behind it.
    assert.ok(
      !sanitizePermissions([PERMISSIONS.PORTAL_ADMIN]).includes(PERMISSIONS.ADMIN_ACCESS),
      'granting a portal must not grant the powers inside it'
    );
  });

  test('but full administrator access still carries the door', () => {
    // The mirror image would be its own trap: every admin power and no way in.
    const holder = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS], deniedPermissions: [] };
    assert.equal(canOpenPortal(holder, PERMISSIONS.PORTAL_ADMIN), true);
  });

  test('a narrow admin grant opens the portal and nothing more', async () => {
    const narrow = { role: 'staff', permissions: [PERMISSIONS.PORTAL_ADMIN, PERMISSIONS.MONITORING_VIEW], deniedPermissions: [] };
    assert.equal(canOpenPortal(narrow, PERMISSIONS.PORTAL_ADMIN), true);
    assert.equal((await run(authorize('admin', 'monitoring.view'), narrow)).allowed, true);
    assert.equal((await run(authorize('admin', 'users.view'), narrow)).allowed, false,
      'the rest of the admin portal must stay shut');
  });
});

describe('area capabilities widen a gate without narrowing it', () => {
  test('the roles already on a gate still pass', async () => {
    // Every gate was widened by appending a capability, never by replacing the
    // role list — so no existing user can lose access at deploy.
    const GATE = ['admin', 'users.view'];
    assert.equal((await run(authorize(...GATE), user('admin'))).allowed, true);
  });

  test('and the capability admits somebody the roles do not', async () => {
    const GATE = ['admin', 'users.view'];
    assert.equal((await run(authorize(...GATE), user('staff', [PERMISSIONS.USERS_VIEW]))).allowed, true);
    assert.equal((await run(authorize(...GATE), user('staff'))).allowed, false);
  });

  test('editing implies viewing', () => {
    assert.ok(sanitizePermissions([PERMISSIONS.USERS_WRITE]).includes(PERMISSIONS.USERS_VIEW));
    assert.ok(sanitizePermissions([PERMISSIONS.LAB_WRITE]).includes(PERMISSIONS.LAB_VIEW));
    assert.ok(sanitizePermissions([PERMISSIONS.APPOINTMENTS_WRITE]).includes(PERMISSIONS.APPOINTMENTS_VIEW));
  });

  test('withdrawing an area holds out someone whose role would allow it', async () => {
    const GATE = ['admin', 'users.view'];
    const shutOut = { role: 'admin', permissions: [], deniedPermissions: [PERMISSIONS.USERS_VIEW] };
    // …except a real admin, who can never be withdrawn from.
    assert.equal((await run(authorize(...GATE), shutOut)).allowed, true);
    const staffShutOut = { role: 'staff', permissions: [PERMISSIONS.USERS_VIEW], deniedPermissions: [PERMISSIONS.USERS_VIEW] };
    assert.equal((await run(authorize(...GATE), staffShutOut)).allowed, false);
  });
});

// =====================================================================
// Staff type — clinical vs non-clinical
//
// The bundle is folded into effectivePermissions() rather than stored on the
// row, so these are the tests that stop it leaking to the wrong people.
// =====================================================================
describe('clinical and non-clinical staff', () => {
  const { PERMISSIONS: P, hasPermission: has } = require('../constants/permissions');
  const staff = (extra = {}) => ({ role: 'staff', permissions: [], deniedPermissions: [], ...extra });

  test('a patient never holds a clinical capability', () => {
    // The regression this exists for: staffType defaults to clinical so that no
    // member of staff loses access at deploy, and a patient row carries the same
    // default. Without a role guard every patient would hold clinical.view and
    // could read every other patient's consultation notes through the very gate
    // added to prevent that.
    const patient = { role: 'patient', permissions: [], deniedPermissions: [] };
    assert.equal(has(patient, P.CLINICAL_VIEW), false);
    assert.equal(has(patient, P.CLINICAL_RECORD), false);
    // Even if a stray value is written to the row.
    assert.equal(has({ ...patient, staffType: 'clinical' }, P.CLINICAL_VIEW), false);
  });

  test('clinical staff hold the bundle without anything granted', () => {
    const nurse = staff({ staffType: 'clinical' });
    for (const cap of [P.CLINICAL_VIEW, P.CLINICAL_RECORD, P.GLP1_WRITE,
                       P.EQUIPMENT_WRITE, P.STOCK_DISPENSE]) {
      assert.equal(has(nurse, cap), true, `${cap} should come with being clinical`);
    }
  });

  test('non-clinical staff hold none of it', () => {
    const reception = staff({ staffType: 'non_clinical' });
    for (const cap of [P.CLINICAL_VIEW, P.CLINICAL_RECORD, P.GLP1_WRITE,
                       P.EQUIPMENT_WRITE, P.STOCK_DISPENSE]) {
      assert.equal(has(reception, cap), false, `${cap} should not follow from being staff`);
    }
  });

  test('an unset staffType is treated as clinical', () => {
    // Deploy-day safety: every existing row has no value, and five of the eight
    // staff accounts in production are nurses. Defaulting to non-clinical would
    // disable most of the clinical workforce the moment the column landed.
    assert.equal(has(staff(), P.CLINICAL_VIEW), true);
  });

  test('a withdrawal beats a clinical default', () => {
    // What makes "clinical, except this one thing" expressible. If the type
    // bundle won, the Permissions tab could not carve an exception out of it.
    const held = staff({ staffType: 'clinical', deniedPermissions: [P.GLP1_WRITE] });
    assert.equal(has(held, P.GLP1_WRITE), false);
    assert.equal(has(held, P.CLINICAL_VIEW), true);
  });

  test('the two per-clinic capabilities are never given by the bundle', () => {
    // Who signs a scan or runs a drug round differs between clinics, so both are
    // granted per person. A clinical default here would hand every nurse the
    // ability to sign an ultrasound report.
    const nurse = staff({ staffType: 'clinical' });
    assert.equal(has(nurse, P.RADIOLOGY_WRITE), false);
    assert.equal(has(nurse, P.MAR_ADMINISTER), false);
  });

  test('a granted per-clinic capability still works', () => {
    const sonographer = staff({ staffType: 'clinical', permissions: [P.RADIOLOGY_WRITE] });
    assert.equal(has(sonographer, P.RADIOLOGY_WRITE), true);
  });
});

describe('the clinical bundle never widens anyone', () => {
  const { PERMISSIONS: P, hasPermission: has } = require('../constants/permissions');

  test('a lab technician is clinical but gains no patient-care writes', () => {
    // The regression this exists for: the old gates on vitals and nursing notes
    // named 'doctor', 'staff' and 'nurse' and never 'lab'. Replacing them with a
    // capability and marking the lab technician clinical would have handed them
    // the whole bundle — silently widening access on a branch whose entire
    // purpose is to narrow it.
    const lab = { role: 'lab', permissions: [], deniedPermissions: [], staffType: 'clinical' };
    assert.equal(has(lab, P.CLINICAL_VIEW), true, 'could always read the record for context');
    for (const cap of [P.CLINICAL_RECORD, P.GLP1_WRITE, P.EQUIPMENT_WRITE, P.STOCK_DISPENSE]) {
      assert.equal(has(lab, cap), false, `${cap} was never open to lab before this branch`);
    }
  });

  test('an explicit grant still reaches a lab technician', () => {
    // The narrowing is a DEFAULT, not a prohibition — a clinic where the lab
    // technician also runs triage can still be expressed through the tab.
    const lab = { role: 'lab', permissions: [P.CLINICAL_RECORD], deniedPermissions: [], staffType: 'clinical' };
    assert.equal(has(lab, P.CLINICAL_RECORD), true);
  });
});

describe('a write always carries the read it acts within', () => {
  const { PERMISSIONS: P, hasPermission: has } = require('../constants/permissions');
  const held = (perms, denied = []) =>
    ({ role: 'staff', staffType: 'non_clinical', permissions: perms, deniedPermissions: denied });

  // sanitizePermissions() adds the implied read whenever the tab saves, so a row
  // written through the UI is consistent. Nothing else was — the older Manage
  // Users screen, a legacy stock.manage expansion, a direct API call or a
  // hand-edited row could all leave someone holding a write without its read.
  // routes/stock.js has claimed since the stock split that
  // "constants/permissions.js enforces the implication"; it only did so at write
  // time, which made that comment false for exactly the rows nobody could debug.
  const PAIRS = [
    [P.STOCK_WRITE,        P.STOCK_ACCESS],
    [P.INPATIENT_WRITE,    P.INPATIENT_ACCESS],
    [P.LAB_WRITE,          P.LAB_VIEW],
    [P.USERS_WRITE,        P.USERS_VIEW],
    [P.APPOINTMENTS_WRITE, P.APPOINTMENTS_VIEW],
    [P.CLINICAL_RECORD,    P.CLINICAL_VIEW],
  ];

  for (const [write, read] of PAIRS) {
    test(`${write} carries ${read}`, () => {
      assert.equal(has(held([write]), read), true,
        'holding the write without the read is a state no screen can show');
    });
  }

  test('the legacy stock.manage row still resolves to both halves', () => {
    assert.equal(has(held(['stock.manage']), P.STOCK_ACCESS), true);
    assert.equal(has(held(['stock.manage']), P.STOCK_WRITE), true);
  });

  test('a withdrawal still beats the implication', () => {
    // Taking the read away has to take it away — otherwise an admin could not
    // stop someone reading a module they can write to, and the withdrawal would
    // silently do nothing.
    const u = held([P.STOCK_WRITE], [P.STOCK_ACCESS]);
    assert.equal(has(u, P.STOCK_ACCESS), false);
  });
});
