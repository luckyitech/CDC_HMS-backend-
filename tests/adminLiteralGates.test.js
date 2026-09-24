const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, ALL_PERMISSIONS,
  passesAdminGate, canViewConfidential, hasPermission,
} = require('../constants/permissions');
const { canViewHr, canWriteHr } = require('../utils/hrAccess');
const { adminOrSelf } = require('../routes/staff');
const { canDecideLeaveFor } = require('../controllers/leaveController');
const { isConfidential } = require('../controllers/staffDocumentController');

// =====================================================================
// The `role === 'admin'` literal fixes (24 Sep 2026) + hr.confidential.
//
// The clinic intends to bench the true admin account and run on admin.access
// (+ permissions.grant for the one power that must not propagate). Every
// remaining `role === 'admin'` on the staff file refused a doctor holding
// admin.access. These gates now answer the capability question instead:
//   - adminOrSelf     → users.view (the gate on the directory it is opened from)
//   - leave approval  → users.write, and never for one's own leave
//   - documents       → hr.confidential for the confidential drawer, an
//                       explicit grant that admin.access does NOT carry
// No database: everything here reads req.user / a fake staffUser.
// =====================================================================

const user = (role, permissions = [], deniedPermissions = [], id = 1) =>
  ({ id, role, permissions, deniedPermissions });

const run = (middleware, req) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware(req, res, () => resolve({ allowed: true }));
});

describe('passesAdminGate mirrors authorize(\'admin\', cap)', () => {
  test('the true admin account passes', () => {
    assert.equal(passesAdminGate(user('admin'), PERMISSIONS.USERS_VIEW), true);
  });
  test('admin.access passes', () => {
    assert.equal(passesAdminGate(user('doctor', [PERMISSIONS.ADMIN_ACCESS]), PERMISSIONS.USERS_VIEW), true);
  });
  test('the capability itself passes', () => {
    assert.equal(passesAdminGate(user('staff', [PERMISSIONS.USERS_VIEW]), PERMISSIONS.USERS_VIEW), true);
  });
  test('an implied read passes (users.write ⇒ users.view)', () => {
    assert.equal(passesAdminGate(user('staff', [PERMISSIONS.USERS_WRITE]), PERMISSIONS.USERS_VIEW), true);
  });
  test('nothing held is refused', () => {
    assert.equal(passesAdminGate(user('doctor'), PERMISSIONS.USERS_VIEW), false);
  });
  test('a withdrawal beats admin.access', () => {
    assert.equal(
      passesAdminGate(user('doctor', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.USERS_VIEW]), PERMISSIONS.USERS_VIEW),
      false,
    );
  });
  test('hrAccess is the same helper in HR spelling', () => {
    const emu = user('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal(canViewHr(emu), true);
    assert.equal(canWriteHr(emu), true);
    assert.equal(canViewHr(user('doctor')), false);
    assert.equal(canWriteHr(user('doctor', [PERMISSIONS.HR_VIEW])), false);
  });
});

describe('adminOrSelf — opening a staff file', () => {
  const someoneElse = { id: 42 };
  test('a doctor holding admin.access opens any file (the bug this fixes)', async () => {
    const req = { user: user('doctor', [PERMISSIONS.ADMIN_ACCESS]), staffUser: someoneElse };
    assert.deepEqual(await run(adminOrSelf, req), { allowed: true });
  });
  test('a holder of users.view opens any file', async () => {
    const req = { user: user('staff', [PERMISSIONS.USERS_VIEW]), staffUser: someoneElse };
    assert.deepEqual(await run(adminOrSelf, req), { allowed: true });
  });
  test('the true admin account still opens any file', async () => {
    const req = { user: user('admin'), staffUser: someoneElse };
    assert.deepEqual(await run(adminOrSelf, req), { allowed: true });
  });
  test('anyone opens their own file', async () => {
    const req = { user: user('nurse'), staffUser: { id: 1 } };
    assert.deepEqual(await run(adminOrSelf, req), { allowed: true });
  });
  test('a plain doctor cannot open a colleague\'s file — 403 through utils/response', async () => {
    const r = await run(adminOrSelf, { user: user('doctor'), staffUser: someoneElse });
    assert.equal(r.allowed, false);
    assert.equal(r.code, 403);
    assert.equal(r.body.success, false);
  });
  test('users.view withdrawn from an admin.access holder refuses', async () => {
    const req = { user: user('doctor', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.USERS_VIEW]), staffUser: someoneElse };
    assert.equal((await run(adminOrSelf, req)).allowed, false);
  });
});

describe('leave — nobody approves their own', () => {
  const colleague = { id: 42 };
  test('admin.access approves a colleague\'s leave', () => {
    assert.equal(canDecideLeaveFor(user('doctor', [PERMISSIONS.ADMIN_ACCESS]), colleague), true);
  });
  test('users.write approves a colleague\'s leave', () => {
    assert.equal(canDecideLeaveFor(user('staff', [PERMISSIONS.USERS_WRITE]), colleague), true);
  });
  test('users.view alone does not approve', () => {
    assert.equal(canDecideLeaveFor(user('staff', [PERMISSIONS.USERS_VIEW]), colleague), false);
  });
  test('the same person recording their OWN leave does not self-approve, whatever they hold', () => {
    assert.equal(canDecideLeaveFor(user('doctor', [PERMISSIONS.ADMIN_ACCESS], [], 42), colleague), false);
    assert.equal(canDecideLeaveFor(user('admin', [], [], 42), colleague), false);
  });
});

describe('hr.confidential — the drawer admin.access does not open', () => {
  test('is a real capability in the vocabulary, with a card carrying a warning', () => {
    assert.ok(ALL_PERMISSIONS.includes(PERMISSIONS.HR_CONFIDENTIAL));
    const area = PERMISSION_GROUPS.flatMap((g) => g.areas).find((a) => a.access === PERMISSIONS.HR_CONFIDENTIAL);
    assert.ok(area, 'needs a Permissions-tab card');
    assert.ok(area.warning, 'the card must warn');
  });
  test('is NOT in ADMIN_ACCESS_COVERS', () => {
    assert.ok(!ADMIN_ACCESS_COVERS.includes(PERMISSIONS.HR_CONFIDENTIAL),
      'admin.access must never confer hr.confidential');
  });
  test('a doctor holding admin.access cannot see confidential documents', () => {
    assert.equal(canViewConfidential(user('doctor', [PERMISSIONS.ADMIN_ACCESS])), false);
    assert.equal(hasPermission(user('doctor', [PERMISSIONS.ADMIN_ACCESS]), PERMISSIONS.HR_CONFIDENTIAL), false);
  });
  test('users.write does not either — managing the file is not reading the drawer', () => {
    assert.equal(canViewConfidential(user('staff', [PERMISSIONS.USERS_WRITE])), false);
  });
  test('no role holds it by default', () => {
    for (const role of ['doctor', 'staff', 'lab', 'nurse']) {
      assert.equal(canViewConfidential(user(role)), false, role);
    }
  });
  test('an explicit grant opens it', () => {
    assert.equal(canViewConfidential(user('doctor', [PERMISSIONS.HR_CONFIDENTIAL])), true);
  });
  test('the true admin account opens it (fallback holder, like every capability)', () => {
    assert.equal(canViewConfidential(user('admin')), true);
  });
  test('a withdrawn grant is closed again', () => {
    assert.equal(
      canViewConfidential(user('doctor', [PERMISSIONS.HR_CONFIDENTIAL], [PERMISSIONS.HR_CONFIDENTIAL])),
      false,
    );
  });
  test('what counts as confidential: "Admin only" visibility, or archived', () => {
    assert.equal(isConfidential({ visibility: 'Admin only', isArchived: false }), true);
    assert.equal(isConfidential({ visibility: 'Staff', isArchived: true }), true);
    assert.equal(isConfidential({ visibility: 'Staff', isArchived: false }), false);
  });
});
