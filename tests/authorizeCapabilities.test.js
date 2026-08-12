const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PERMISSIONS } = require('../constants/permissions');
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
    // stock.manage must not open an inpatient.access gate.
    const stockOnly = user('staff', [PERMISSIONS.STOCK_MANAGE]);
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
