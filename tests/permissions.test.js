const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const {
  PERMISSIONS, ALL_PERMISSIONS, PERMISSIBLE_ROLES,
  effectivePermissions, hasPermission, isTrueAdmin, sanitizePermissions,
} = require('../constants/permissions');
const { authorize, requirePermission, requireTrueAdmin } = require('../middleware/auth');
const userController = require('../controllers/userController');

// =====================================================================
// Per-user permissions: a doctor/staff/lab account can be granted admin
// capabilities without becoming an admin.
//
// The rules that matter are the ones that stop the grant escaping: only a real
// admin account may grant, and a granted user must not be able to widen their
// own access. Those are asserted here rather than assumed.
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run permission tests against production.');
}

const TAG = '__TEST_PERMS__';
const made = [];
let realAdmin;

// Minimal express double — the middleware only ever calls next() or res.status().json().
const run = (middleware, user) => new Promise((resolve) => {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; resolve({ allowed: false, code: res.code, body: b }); return res; };
  middleware({ user }, res, () => resolve({ allowed: true }));
});

const mkUser = async (role, permissions = []) => {
  const u = await db.User.create({
    firstName: 'Perm', lastName: 'Test',
    email: `${TAG}.${role}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@cdc.test`,
    password: 'x', role, isActive: true, permissions,
  });
  made.push(u.id);
  return u;
};

before(async () => {
  await db.sequelize.authenticate();
  realAdmin = { id: 0, role: 'admin', permissions: [] };
});

after(async () => {
  await db.User.destroy({ where: { id: { [Op.in]: made.length ? made : [0] } } });
  const leftover = await db.User.count({ where: { email: { [Op.like]: `%${TAG}%` } } });
  assert.equal(leftover, 0, 'test users were not cleaned up');
  await db.sequelize.close();
});

// ---------------------------------------------------------------------

describe('a real admin needs nothing granted', () => {
  test('holds every permission implicitly, storing none', () => {
    const admin = { role: 'admin', permissions: [] };
    ALL_PERMISSIONS.forEach((p) =>
      assert.ok(hasPermission(admin, p), `admin should hold ${p}`));
    assert.equal(effectivePermissions(admin).size, ALL_PERMISSIONS.length);
    // Storing the list on the admin row would be a second copy of the same
    // fact, free to drift from ALL_PERMISSIONS.
    assert.deepEqual(admin.permissions, []);
  });
});

describe('granted admin access reaches admin-only routes', () => {
  test('authorize("admin") admits a holder of admin.access', async () => {
    const staff = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };
    const gate = authorize('admin');
    assert.equal((await run(gate, staff)).allowed, true);
  });

  test('and still refuses a staff account without it', async () => {
    const staff = { role: 'staff', permissions: [] };
    const res = await run(authorize('admin'), staff);
    assert.equal(res.allowed, false);
    assert.equal(res.code, 403);
  });

  test('a grant does not widen anything else', async () => {
    // admin.access must not imply stock.write: capabilities are independent,
    // or the whole point of separating them is lost.
    const staff = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };
    const res = await run(requirePermission(PERMISSIONS.STOCK_WRITE), staff);
    assert.equal(res.allowed, false, 'admin.access must not imply stock.write');
  });

  test('authorize with unrelated roles is unaffected by admin.access', async () => {
    // authorize('doctor') should not admit a granted staff member — the
    // permission substitutes for 'admin' only.
    const staff = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };
    const res = await run(authorize('doctor'), staff);
    assert.equal(res.allowed, false);
  });
});

describe('the grant cannot escape', () => {
  test('requireTrueAdmin refuses a holder of admin.access', async () => {
    const granted = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };
    const res = await run(requireTrueAdmin, granted);
    assert.equal(res.allowed, false, 'a granted user must not pass a true-admin gate');
    assert.equal(res.code, 403);
    assert.equal((await run(requireTrueAdmin, realAdmin)).allowed, true);
  });

  test('a granted user cannot grant permissions to anyone', async () => {
    const target = await mkUser('doctor');
    const granted = { id: 999999, role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };

    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await userController.updateUser({
      params: { id: String(target.id) },
      body: { permissions: [PERMISSIONS.ADMIN_ACCESS] },
      user: granted,
    }, res);

    assert.equal(res.code, 403, 'only a real admin account may grant');
    await target.reload();
    assert.deepEqual(target.permissions, [], 'nothing may have been written');
  });

  test('a real admin can grant, and it is stored', async () => {
    const target = await mkUser('staff');
    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };

    await userController.updateUser({
      params: { id: String(target.id) },
      body: { permissions: [PERMISSIONS.ADMIN_ACCESS] },
      user: realAdmin,
    }, res);

    await target.reload();
    assert.deepEqual(target.permissions, [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal(hasPermission(target, PERMISSIONS.ADMIN_ACCESS), true);
  });

  test('a revoke actually removes it', async () => {
    const target = await mkUser('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };

    await userController.updateUser({
      params: { id: String(target.id) },
      body: { permissions: [] },
      user: realAdmin,
    }, res);

    await target.reload();
    assert.deepEqual(target.permissions, []);
    assert.equal(hasPermission(target, PERMISSIONS.ADMIN_ACCESS), false);
  });
});

describe('patients can never hold permissions', () => {
  test('granting to a patient is refused', async () => {
    const patient = await mkUser('patient');
    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };

    await userController.updateUser({
      params: { id: String(patient.id) },
      body: { permissions: [PERMISSIONS.ADMIN_ACCESS] },
      user: realAdmin,
    }, res);

    assert.equal(res.code, 400);
    await patient.reload();
    assert.deepEqual(patient.permissions, []);
  });

  test('the permissible roles are exactly doctor, staff, lab and nurse', () => {
    // 'nurse' joined PERMISSIBLE_ROLES in 75ca595 (HMIS V3 inpatient module) and
    // this assertion was never updated with it, so the suite has been red on main
    // since. Nursing is first-class now — a nurse holding inpatient.access is the
    // whole point of the capability — so the constant is right and the test was
    // stale, not the other way round.
    assert.deepEqual([...PERMISSIBLE_ROLES].sort(), ['doctor', 'lab', 'nurse', 'staff']);
    // The part that actually matters and must never change:
    assert.ok(!PERMISSIBLE_ROLES.includes('patient'));
    assert.ok(!PERMISSIBLE_ROLES.includes('admin'), 'admins hold everything implicitly');
  });
});

describe('unknown permission names are dropped, not stored', () => {
  test('sanitize keeps only known permissions', () => {
    assert.deepEqual(
      sanitizePermissions([PERMISSIONS.ADMIN_ACCESS, 'admin.acess', 'wildcard.*', null, 42]),
      [PERMISSIONS.ADMIN_ACCESS],
      'a typo must grant nothing rather than store a string nobody checks'
    );
    assert.deepEqual(sanitizePermissions('admin.access'), [], 'a bare string is not a list');
    assert.deepEqual(sanitizePermissions(undefined), []);
  });

  test('a typo written through the API grants nothing', async () => {
    const target = await mkUser('lab');
    const res = { code: 200, body: null };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };

    await userController.updateUser({
      params: { id: String(target.id) },
      body: { permissions: ['admin.acess'] },   // deliberate typo
      user: realAdmin,
    }, res);

    await target.reload();
    assert.deepEqual(target.permissions, []);
    assert.equal(hasPermission(target, PERMISSIONS.ADMIN_ACCESS), false);
  });
});

describe('role is still the identity', () => {
  test('a granted user is not a true admin', () => {
    const granted = { role: 'staff', permissions: [PERMISSIONS.ADMIN_ACCESS] };
    assert.equal(isTrueAdmin(granted), false);
    assert.equal(granted.role, 'staff', 'the grant must not change who they are');
    assert.equal(isTrueAdmin({ role: 'admin' }), true);
  });

  test('effectivePermissions copes with missing or malformed data', () => {
    assert.equal(effectivePermissions(null).size, 0);
    assert.equal(effectivePermissions({ role: 'staff' }).size, 0);
    assert.equal(effectivePermissions({ role: 'staff', permissions: null }).size, 0);
    assert.equal(effectivePermissions({ role: 'staff', permissions: 'nope' }).size, 0);
  });
});
