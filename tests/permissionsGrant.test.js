const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, canGrantPermissions, hasPermission,
} = require('../constants/permissions');
const { requireTrueAdmin } = require('../middleware/auth');

// =====================================================================
// permissions.grant — the one capability that must not propagate.
//
// Decision of record: claude/session-2026-09-24-permissions-grant-decision.md
//   - NOT covered by admin.access (admins run the clinic, key-holders decide
//     who else may)
//   - the true 'admin' account is a no-lockout fallback holder
//   - nobody can grant it to themselves
// No database: everything here reads req.user / a fake staffUser.
// =====================================================================

const user = (role, permissions = [], deniedPermissions = [], id = 1) =>
  ({ id, role, permissions, deniedPermissions });

const run = (middleware, u) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware({ user: u }, res, () => resolve({ allowed: true }));
});

describe('the invariant: admin.access does not carry the key', () => {
  test('permissions.grant is NOT in ADMIN_ACCESS_COVERS', () => {
    assert.ok(!ADMIN_ACCESS_COVERS.includes(PERMISSIONS.PERMISSIONS_GRANT),
      'admin.access must never confer permissions.grant');
  });

  test('a doctor holding admin.access still cannot grant', () => {
    assert.equal(canGrantPermissions(user('doctor', [PERMISSIONS.ADMIN_ACCESS])), false);
  });

  test('a doctor holding admin.access does not have permissions.grant as an effective permission', () => {
    assert.equal(hasPermission(user('doctor', [PERMISSIONS.ADMIN_ACCESS]), PERMISSIONS.PERMISSIONS_GRANT), false);
  });

  test('no role holds it by default', () => {
    for (const role of ['doctor', 'staff', 'lab', 'nurse']) {
      assert.equal(canGrantPermissions(user(role)), false, role);
    }
  });
});

describe('who can grant', () => {
  test('a holder of permissions.grant can', () => {
    assert.equal(canGrantPermissions(user('doctor', [PERMISSIONS.PERMISSIONS_GRANT])), true);
  });

  test('the true admin account can (no-lockout fallback)', () => {
    assert.equal(canGrantPermissions(user('admin')), true);
  });

  test('a withdrawn key is not a key', () => {
    assert.equal(
      canGrantPermissions(user('doctor', [PERMISSIONS.PERMISSIONS_GRANT], [PERMISSIONS.PERMISSIONS_GRANT])),
      false,
    );
  });
});

describe('requireTrueAdmin (now a capability gate)', () => {
  test('admits a key-holder', async () => {
    assert.deepEqual(await run(requireTrueAdmin, user('doctor', [PERMISSIONS.PERMISSIONS_GRANT])), { allowed: true });
  });
  test('admits the true admin account', async () => {
    assert.deepEqual(await run(requireTrueAdmin, user('admin')), { allowed: true });
  });
  test('refuses admin.access alone with 403', async () => {
    const r = await run(requireTrueAdmin, user('doctor', [PERMISSIONS.ADMIN_ACCESS]));
    assert.equal(r.allowed, false);
    assert.equal(r.code, 403);
  });
  test('refuses a plain doctor with 403', async () => {
    const r = await run(requireTrueAdmin, user('doctor'));
    assert.equal(r.allowed, false);
    assert.equal(r.code, 403);
  });
});

describe('the Permissions tab shows it', () => {
  test('there is exactly one row for permissions.grant, in the Administration group, with a warning', () => {
    const rows = PERMISSION_GROUPS.flatMap((g) => g.areas.map((a) => ({ group: g.key, ...a })))
      .filter((a) => a.access === PERMISSIONS.PERMISSIONS_GRANT || a.write === PERMISSIONS.PERMISSIONS_GRANT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].group, 'administration');
    assert.ok(rows[0].warning && rows[0].warning.length > 20, 'must carry a warning');
  });
});

// ---------------------------------------------------------------------
// The controller's two refusal rules, driven with a fake req/res and a fake
// staffUser so no database is needed. Only the pre-write guards are exercised;
// a success path would need a real user.update() and belongs to the DB harness.
// ---------------------------------------------------------------------
describe('staffController.updatePermissions guards', () => {
  const { updatePermissions } = require('../controllers/staffController');

  const call = (caller, target, body) => new Promise((resolve) => {
    const res = { code: 200 };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => resolve({ code: res.code, body: b });
    updatePermissions({ user: caller, staffUser: target, staffProfile: {}, body }, res);
  });

  const target = (id, permissions = []) => ({
    id, role: 'doctor', permissions, deniedPermissions: [], staffType: 'clinical',
    update: async () => { throw new Error('should not reach update()'); },
  });

  test('admin.access alone cannot hand out the key → 403', async () => {
    const caller = user('doctor', [PERMISSIONS.ADMIN_ACCESS], [], 10);
    const r = await call(caller, target(20), { permissions: [PERMISSIONS.PERMISSIONS_GRANT] });
    assert.equal(r.code, 403);
    assert.match(r.body.message, /permissions administrator/i);
  });

  test('a key-holder cannot grant the key to themselves → 403', async () => {
    // Caller holds the key at the moment of the call, but the target row does
    // not yet — the classic "add it to my own list" attempt.
    const caller = user('doctor', [PERMISSIONS.PERMISSIONS_GRANT], [], 10);
    const r = await call(caller, target(10), { permissions: [PERMISSIONS.PERMISSIONS_GRANT] });
    assert.equal(r.code, 403);
    assert.match(r.body.message, /yourself/i);
  });

  test('retaining an already-held key on your own row is not a self-grant', async () => {
    // The self-grant guard only fires when the key is NEW to the row. A holder
    // editing their own other permissions must not be rejected for keeping it.
    // We prove the guard was passed by seeing the call reach update() (which
    // our fake throws on) rather than returning 403 first.
    const caller = user('doctor', [PERMISSIONS.PERMISSIONS_GRANT], [], 10);
    const t = target(10, [PERMISSIONS.PERMISSIONS_GRANT]);
    const r = await call(caller, t, { permissions: [PERMISSIONS.PERMISSIONS_GRANT, PERMISSIONS.HR_VIEW] });
    assert.equal(r.code, 500, 'reached update() (fake throws) — i.e. the guard did not refuse');
  });
});
