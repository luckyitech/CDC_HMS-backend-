const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, INTERNAL_ROLES, ADMIN_ACCESS_COVERS, canOpenPortal, hasPermission, sanitizePermissions, sanitizeDeniedPermissions,
} = require('../constants/permissions');
const { authorize } = require('../middleware/auth');
const { canViewHr, canWriteHr } = require('../utils/hrAccess');

// =====================================================================
// HR Suite (B21) — who gets in. No database: authorize() and the helpers
// only read req.user. The route gates are copied from routes/hr.js so a
// drift there shows up here.
// =====================================================================

const CHECKIN = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.checkin'];
const VIEW    = ['admin', 'hr.view'];
const WRITE   = ['admin', 'hr.write'];

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
    assert.equal((await run(authorize(...WRITE), user('admin'))).allowed, true);
    assert.equal(canWriteHr(user('admin')), true);
  });
  test('admin.access covers both (Emu\'s doctor + admin.access account is an HR user)', async () => {
    const emu = user('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    assert.equal((await run(authorize(...VIEW), emu)).allowed, true);
    assert.equal((await run(authorize(...WRITE), emu)).allowed, true);
    assert.equal(canViewHr(emu), true);
    assert.equal(canWriteHr(emu), true);
    assert.ok(ADMIN_ACCESS_COVERS.includes(PERMISSIONS.HR_VIEW));
    assert.ok(ADMIN_ACCESS_COVERS.includes(PERMISSIONS.HR_WRITE));
    assert.ok(ADMIN_ACCESS_COVERS.includes(PERMISSIONS.HR_CHECKIN));
  });
  test('hr.write implies hr.view', async () => {
    const hr = user('staff', [PERMISSIONS.HR_WRITE]);
    assert.equal(hasPermission(hr, PERMISSIONS.HR_VIEW), true);
    assert.equal((await run(authorize(...VIEW), hr)).allowed, true);
    assert.deepEqual(sanitizePermissions([PERMISSIONS.HR_WRITE]).sort(), [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_WRITE].sort());
  });
  test('withdrawing hr.view takes hr.write with it, and beats admin.access', async () => {
    assert.deepEqual(sanitizeDeniedPermissions([PERMISSIONS.HR_VIEW]).sort(), [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_WRITE].sort());
    const held = user('doctor', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.HR_VIEW, PERMISSIONS.HR_WRITE]);
    assert.equal((await run(authorize(...VIEW), held)).allowed, false);
    assert.equal(canViewHr(held), false);
    assert.equal(canWriteHr(held), false);
  });
  test('hr.view alone does not amend', async () => {
    const viewer = user('lab', [PERMISSIONS.HR_VIEW]);
    assert.equal((await run(authorize(...VIEW), viewer)).allowed, true);
    assert.equal((await run(authorize(...WRITE), viewer)).allowed, false);
    assert.equal(canWriteHr(viewer), false);
  });
});
