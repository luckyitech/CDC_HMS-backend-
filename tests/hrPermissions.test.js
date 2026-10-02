const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, INTERNAL_ROLES, ADMIN_ACCESS_COVERS, canOpenPortal, hasPermission, sanitizePermissions, sanitizeDeniedPermissions,
} = require('../constants/permissions');
const { authorize } = require('../middleware/auth');
const { canViewHr, canManageCheckinDevices } = require('../utils/hrAccess');

// =====================================================================
// HR Suite (B21) — who gets in. No database: authorize() and the helpers
// only read req.user. The route gates are copied from routes/hr.js so a
// drift there shows up here.
// =====================================================================

const CHECKIN = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.checkin'];
const VIEW    = ['admin', 'hr.view'];
// hr.write was split (HR Tier 3 Phase 0); amending is its own capability.
const AMEND   = ['admin', 'hr.attendance.amend'];

const run = (middleware, user) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware({ user }, res, () => resolve({ allowed: true }));
});
const user = (role, permissions = [], deniedPermissions = []) => ({ role, permissions, deniedPermissions });

describe('the HR Suite portal', () => {
  test('every internal role opens it by default', () => {
    for (const role of INTERNAL_ROLES) assert.ok(canOpenPortal(user(role), PERMISSIONS.PORTAL_HR), role);
  });
  test('a patient never does', () => {
    assert.equal(canOpenPortal(user('patient'), PERMISSIONS.PORTAL_HR), false);
  });
  test('it can be withdrawn from one person', () => {
    assert.equal(canOpenPortal(user('nurse', [], [PERMISSIONS.PORTAL_HR]), PERMISSIONS.PORTAL_HR), false);
  });
});

describe('checking in', () => {
  test('every internal role passes the tap gate by role', async () => {
    for (const role of INTERNAL_ROLES) assert.equal((await run(authorize(...CHECKIN), user(role))).allowed, true, role);
  });
  test('a withdrawal of hr.checkin refuses the tap even for a doctor', async () => {
    const r = await run(authorize(...CHECKIN), user('doctor', [], [PERMISSIONS.HR_CHECKIN]));
    assert.equal(r.allowed, false); assert.equal(r.code, 403);
    assert.match(r.body.message, /withdrawn/);
  });
  test('a patient is refused', async () => {
    assert.equal((await run(authorize(...CHECKIN), user('patient'))).allowed, false);
  });
});

describe('seeing and amending everyone\'s attendance', () => {
  test('a plain doctor is refused', async () => {
    assert.equal((await run(authorize(...VIEW), user('doctor'))).allowed, false);
    assert.equal(canViewHr(user('doctor')), false);
  });
  test('the admin role passes', async () => {
    assert.equal((await run(authorize(...AMEND), user('admin'))).allowed, true);
    assert.equal(canManageCheckinDevices(user('admin')), true);
  });
  test('admin.access covers all of it (Emu\'s doctor + admin.access account is an HR user)', async () => {
    const emu = user('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal((await run(authorize(...VIEW), emu)).allowed, true);
    assert.equal((await run(authorize(...AMEND), emu)).allowed, true);
    assert.equal(canViewHr(emu), true);
    assert.equal(canManageCheckinDevices(emu), true);
    for (const cap of [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND, PERMISSIONS.HR_WORKHOURS,
      PERMISSIONS.HR_TAGS, PERMISSIONS.HR_CHECKIN]) assert.ok(ADMIN_ACCESS_COVERS.includes(cap), cap);
  });
  test('a stored hr.write (before HR Tier 3) still holds everything it held', async () => {
    const hr = user('staff', ['hr.write']);
    for (const cap of [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND, PERMISSIONS.HR_WORKHOURS, PERMISSIONS.HR_TAGS]) {
      assert.equal(hasPermission(hr, cap), true, cap);
    }
    assert.equal((await run(authorize(...AMEND), hr)).allowed, true);
    // The next save stores the parts, never the retired name.
    assert.deepEqual(sanitizePermissions(['hr.write']).sort(),
      [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND, PERMISSIONS.HR_WORKHOURS, PERMISSIONS.HR_TAGS].sort());
  });
  test('a stored withdrawal of hr.write still refuses all of it, even with admin.access', async () => {
    const refused = user('doctor', [PERMISSIONS.ADMIN_ACCESS], ['hr.write']);
    assert.equal((await run(authorize(...VIEW), refused)).allowed, false);
    assert.equal((await run(authorize(...AMEND), refused)).allowed, false);
    assert.equal(canManageCheckinDevices(refused), false);
  });
  test('amending and working hours need the read; withdrawing hr.view takes them with it', async () => {
    assert.deepEqual(sanitizePermissions([PERMISSIONS.HR_ATTENDANCE_AMEND]).sort(),
      [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND].sort());
    assert.deepEqual(sanitizeDeniedPermissions([PERMISSIONS.HR_VIEW]).sort(),
      [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND, PERMISSIONS.HR_WORKHOURS].sort());
    const held = user('doctor', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_ATTENDANCE_AMEND]);
    assert.equal((await run(authorize(...VIEW), held)).allowed, false);
    assert.equal(canViewHr(held), false);
  });
  test('hr.view alone does not amend', async () => {
    const viewer = user('lab', [PERMISSIONS.HR_VIEW]);
    assert.equal((await run(authorize(...VIEW), viewer)).allowed, true);
    assert.equal((await run(authorize(...AMEND), viewer)).allowed, false);
    assert.equal(canManageCheckinDevices(viewer), false);
  });
});
