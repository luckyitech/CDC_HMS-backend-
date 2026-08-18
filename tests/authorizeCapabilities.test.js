const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, hasPermission, sanitizePermissions, sanitizeDeniedPermissions,
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
