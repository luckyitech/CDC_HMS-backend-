// HR Suite Tier 3, Phase 0 (2 Oct 2026) — delegated HR permissions.
// The HR group of the Permissions tab split into single-task controls, bundles
// that keep every old grant whole, and "Grant HR permissions" (hr.grant).
// Pure: no database — the gates read only req.user / req.staffUser.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  PERMISSIONS, PERMISSION_GROUPS, ADMIN_ACCESS_COVERS, PRESET_EXCLUDED, BUNDLES,
  HR_DELEGABLE, HR_NOT_DELEGABLE, hasPermission, effectivePermissions, deniedPermissions,
  passesAdminGate, sanitizePermissions, sanitizeDeniedPermissions, reconcilePermissionLists,
  canGrantHrPermissions, canEditPermissions, displayedPermissions,
} = require('../constants/permissions');
const { authorize } = require('../middleware/auth');
const { leaveViewOrSelf, documentUploader } = require('../routes/staff');
const { hrGrantRefusal } = require('../controllers/staffController');
const { canSeeHealthDocumentsOf } = require('../utils/hrAccess');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const user = (role, permissions = [], deniedPermissions = [], id = 1) => ({ id, role, permissions, deniedPermissions });
const run = (middleware, req) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware(req, res, () => resolve({ allowed: true }));
});
const P = PERMISSIONS;

describe('the old broad controls keep everything they gave (bundles)', () => {
  test('users.view opens staff files; users.write carries every staff-file job', () => {
    assert.equal(hasPermission(user('staff', [P.USERS_VIEW]), P.STAFF_VIEW), true);
    const w = user('staff', [P.USERS_WRITE]);
    for (const cap of [P.STAFF_VIEW, P.STAFF_EDIT, P.STAFF_ONBOARD, P.STAFF_STATUS, P.STAFF_DOCUMENTS]) {
      assert.equal(hasPermission(w, cap), true, cap);
    }
  });
  test('leave.manage carries see-everyone, sick details, required approvers and the register', () => {
    const m = user('staff', [P.LEAVE_MANAGE]);
    for (const cap of [P.LEAVE_VIEW, P.LEAVE_SICK, P.LEAVE_REQUIRED, P.LEAVE_REGISTER]) {
      assert.equal(hasPermission(m, cap), true, cap);
    }
  });
  test('leave.policy carries holidays, entitlements and (through leave.manage) all of the above', () => {
    const p = user('staff', [P.LEAVE_POLICY]);
    for (const cap of [P.LEAVE_HOLIDAYS, P.LEAVE_ENTITLEMENTS, P.LEAVE_MANAGE, P.LEAVE_VIEW, P.LEAVE_SICK, P.LEAVE_REGISTER]) {
      assert.equal(hasPermission(p, cap), true, cap);
    }
  });
  test('a stored hr.credentials holds both halves; a withdrawal of it refuses both', () => {
    const h = user('staff', ['hr.credentials']);
    assert.equal(hasPermission(h, P.CPD_VERIFY), true);
    assert.equal(hasPermission(h, P.HR_EXPIRY_ALERTS), true);
    const refused = user('doctor', [P.ADMIN_ACCESS], ['hr.credentials']);
    assert.equal(passesAdminGate(refused, P.CPD_VERIFY), false);
    assert.equal(passesAdminGate(refused, P.HR_EXPIRY_ALERTS), false);
  });
  test('bundles are never written to a row — granting leave.manage stores leave.manage (and its read)', () => {
    assert.deepEqual(sanitizePermissions([P.LEAVE_MANAGE]).sort(), [P.LEAVE_MANAGE, P.LEAVE_VIEW].sort());
  });
});

describe('withdrawing a part leaves the bundle; withdrawing the bundle withdraws its parts', () => {
  test('"manages leave, but not sick-leave details"', () => {
    const u = user('staff', [P.LEAVE_MANAGE], [P.LEAVE_SICK]);
    assert.equal(hasPermission(u, P.LEAVE_MANAGE), true);
    assert.equal(hasPermission(u, P.LEAVE_VIEW), true);
    assert.equal(hasPermission(u, P.LEAVE_SICK), false);
    // The stored denial does not take leave.manage with it.
    assert.deepEqual(sanitizeDeniedPermissions([P.LEAVE_SICK]), [P.LEAVE_SICK]);
  });
  test('a withdrawal of users.write (before Tier 3) still refuses every staff-file write, even with admin.access', async () => {
    const u = user('doctor', [P.ADMIN_ACCESS], [P.USERS_WRITE]);
    for (const cap of [P.STAFF_EDIT, P.STAFF_ONBOARD, P.STAFF_STATUS, P.STAFF_DOCUMENTS]) {
      assert.equal(passesAdminGate(u, cap), false, cap);
      assert.equal((await run(authorize('admin', cap), { user: u })).allowed, false, cap);
    }
    assert.equal(passesAdminGate(u, P.STAFF_VIEW), true, 'viewing is users.view, not withdrawn');
  });
  test('withdrawing leave.view refuses leave.manage and leave.policy too (a chain)', () => {
    const denied = sanitizeDeniedPermissions([P.LEAVE_VIEW]);
    for (const cap of [P.LEAVE_MANAGE, P.LEAVE_SICK, P.LEAVE_REQUIRED, P.LEAVE_POLICY]) assert.ok(denied.includes(cap), cap);
  });
  test('a real admin can never be refused anything', () => {
    assert.equal(deniedPermissions(user('admin', [], [P.LEAVE_SICK])).size, 0);
  });
});

describe('admin.access covers the new controls (but not hr.grant)', () => {
  test('every new HR control is covered and drawn as ticked for an admin.access holder', () => {
    const shown = displayedPermissions(user('doctor', [P.ADMIN_ACCESS]));
    for (const cap of [P.STAFF_VIEW, P.STAFF_EDIT, P.STAFF_ONBOARD, P.STAFF_STATUS, P.STAFF_DOCUMENTS,
      P.HR_ATTENDANCE_AMEND, P.HR_WORKHOURS, P.HR_TAGS, P.CPD_VERIFY, P.HR_EXPIRY_ALERTS,
      P.LEAVE_VIEW, P.LEAVE_SICK, P.LEAVE_REQUIRED, P.LEAVE_REGISTER, P.LEAVE_HOLIDAYS, P.LEAVE_ENTITLEMENTS]) {
      assert.ok(ADMIN_ACCESS_COVERS.includes(cap), cap);
      assert.ok(shown.includes(cap), `${cap} drawn`);
    }
  });
  test('hr.grant is not covered by admin.access, and admin.access does not make an HR grantor', () => {
    assert.equal(ADMIN_ACCESS_COVERS.includes(P.HR_GRANT), false);
    assert.equal(canGrantHrPermissions(user('doctor', [P.ADMIN_ACCESS])), false);
    assert.equal(canGrantHrPermissions(user('staff', [P.HR_GRANT])), true);
    assert.equal(canGrantHrPermissions(user('staff', [P.HR_GRANT], [P.HR_GRANT])), false);
    assert.equal(canGrantHrPermissions(user('admin')), true, 'the true admin fallback');
  });
  test('hr.grant is never in a preset', () => {
    assert.ok(PRESET_EXCLUDED.includes(P.HR_GRANT));
  });
});

describe('the Permissions tab — HR Suite groups', () => {
  const hrAreas = PERMISSION_GROUPS.filter((g) => g.hr).flatMap((g) => g.areas);
  test('six HR groups, every one marked hr, one capability per area', () => {
    const groups = PERMISSION_GROUPS.filter((g) => g.hr).map((g) => g.key);
    assert.deepEqual(groups, ['hr-self', 'hr-people', 'hr-attendance', 'hr-leave', 'hr-development', 'hr-admin']);
    for (const a of hrAreas) assert.ok(a.access && !a.write, `${a.key}: one control per area`);
  });
  test('the retired names are gone from the tab', () => {
    const all = PERMISSION_GROUPS.flatMap((g) => g.areas).flatMap((a) => [a.access, a.write]);
    assert.ok(!all.includes('hr.write'));
    assert.ok(!all.includes('hr.credentials'));
  });
  test('sick-leave details and status changes warn before they are ticked', () => {
    for (const cap of [P.LEAVE_SICK, P.STAFF_STATUS, P.HR_GRANT]) {
      assert.ok(hrAreas.find((a) => a.access === cap).warning, cap);
    }
  });
  test('delegable = every HR control except confidential documents and hr.grant itself', () => {
    assert.deepEqual([...HR_NOT_DELEGABLE].sort(), [P.HR_CONFIDENTIAL, P.HR_GRANT].sort());
    for (const a of hrAreas) {
      assert.equal(HR_DELEGABLE.includes(a.access), !HR_NOT_DELEGABLE.includes(a.access), a.access);
    }
    // Nothing outside the HR groups is ever delegable.
    for (const cap of [P.USERS_WRITE, P.USERS_VIEW, P.ADMIN_ACCESS, P.CLINICAL_VIEW, P.PERMISSIONS_GRANT]) {
      assert.equal(HR_DELEGABLE.includes(cap), false, cap);
    }
  });
});

describe('Grant HR permissions — what a holder may change (hrGrantRefusal)', () => {
  const mary = user('staff', [P.HR_GRANT, P.LEAVE_MANAGE, P.HR_VIEW], [], 10);   // HR manager
  const peter = { id: 20, role: 'staff', permissions: [], deniedPermissions: [], staffType: 'non_clinical' };
  const lists = (permissions, deniedPermissions = [], staffType = 'non_clinical') => {
    const r = reconcilePermissionLists(permissions, deniedPermissions);
    return { permissions: r.granted, deniedPermissions: r.denied, staffType };
  };
  const before = lists([]);

  test('may give an HR control she holds', () => {
    assert.equal(hrGrantRefusal({ caller: mary, target: peter, before, after: lists([P.LEAVE_VIEW]) }), null);
    assert.equal(hrGrantRefusal({ caller: mary, target: peter, before, after: lists([P.LEAVE_APPROVE]) }) === null, false,
      'leave.approve is HR, but Mary does not hold it');
  });
  test('may take one away (a withdrawal is a change too) — even one she does not hold', () => {
    assert.equal(hrGrantRefusal({ caller: mary, target: peter, before, after: lists([], [P.HR_VIEW]) }), null);
    assert.equal(hrGrantRefusal({ caller: mary, target: peter, before, after: lists([], [P.LEAVE_APPROVE]) }), null);
  });
  test('lifting a withdrawal is giving — only what she holds', () => {
    const held = lists([], [P.LEAVE_APPROVE]);
    const r = hrGrantRefusal({ caller: mary, target: peter, before: held, after: lists([]) });
    assert.equal(r?.extra?.code, 'NOT_HELD');
  });
  test('never anything outside HR', () => {
    const r = hrGrantRefusal({ caller: mary, target: peter, before, after: lists([P.CLINICAL_VIEW]) });
    assert.equal(r.code, 403); assert.equal(r.extra.code, 'NOT_DELEGABLE');
    assert.ok(hrGrantRefusal({ caller: mary, target: peter, before, after: lists([P.USERS_WRITE]) }));
  });
  test('never confidential documents or hr.grant — even if she holds them', () => {
    const boss = user('staff', [P.HR_GRANT, P.HR_CONFIDENTIAL], [], 11);
    for (const cap of [P.HR_CONFIDENTIAL, P.HR_GRANT]) {
      const r = hrGrantRefusal({ caller: boss, target: peter, before, after: lists([cap]) });
      assert.equal(r?.extra?.code, 'NOT_DELEGABLE', cap);
    }
  });
  test('never her own file', () => {
    const r = hrGrantRefusal({ caller: mary, target: { ...peter, id: 10 }, before, after: lists([P.LEAVE_VIEW]) });
    assert.equal(r.code, 403);
  });
  test('never a permissions administrator, an admin.access holder or the true admin', () => {
    for (const target of [
      { ...peter, permissions: [P.PERMISSIONS_GRANT] },
      { ...peter, permissions: [P.ADMIN_ACCESS] },
      { ...peter, role: 'admin' },
    ]) {
      assert.ok(hrGrantRefusal({ caller: mary, target, before, after: lists([P.LEAVE_VIEW]) }), JSON.stringify(target.permissions));
    }
  });
  test('never the staff type', () => {
    const r = hrGrantRefusal({ caller: mary, target: peter, before, after: lists([], [], 'clinical') });
    assert.equal(r.code, 403);
  });
  test('an unchanged non-HR grant on the person is not her change', () => {
    const withClinical = lists([P.CLINICAL_VIEW]);
    assert.equal(hrGrantRefusal({ caller: mary, target: peter, before: withClinical,
      after: lists([P.CLINICAL_VIEW, P.LEAVE_VIEW]) }), null);
  });
});

describe('routes', () => {
  const staff = read('routes', 'staff.js');
  const hr = read('routes', 'hr.js');
  const users = read('routes', 'users.js');
  test('the staff file: one capability per job', () => {
    assert.match(staff, /router\.get\('\/', authenticate, authorize\(\.\.\.STAFF_VIEW\)/);
    assert.match(staff, /router\.put\('\/:employeeId', authenticate, authorize\(\.\.\.STAFF_EDIT\)/);
    assert.match(staff, /router\.patch\('\/:employeeId\/status', authenticate, authorize\(\.\.\.STAFF_STATUS\)/);
    assert.match(staff, /router\.delete\('\/:employeeId', authenticate, authorize\(\.\.\.STAFF_STATUS\)/);
    assert.match(staff, /router\.patch\('\/:employeeId\/restore', authenticate, authorize\(\.\.\.STAFF_STATUS\)/);
    for (const m of [/router\.patch\('\/:employeeId\/documents\/:id',/, /router\.delete\('\/:employeeId\/documents\/:id',/,
      /router\.patch\('\/:employeeId\/documents\/:id\/restore',/]) {
      const line = staff.split('\n').find((l) => m.test(l));
      assert.match(line, /authorize\(\.\.\.STAFF_DOCS\)/, line);
    }
    assert.match(staff, /router\.post\('\/:employeeId\/documents', authenticate, findStaff, documentUploader,/);
    assert.match(staff, /router\.patch\('\/:employeeId\/permissions', authenticate, permissionsEditor,/);
    assert.match(staff, /router\.get\('\/permissions\/catalog', authenticate, catalogReader,/);
    const routeLines = staff.split('\n').filter((l) => /^router\./.test(l));
    for (const l of routeLines) assert.doesNotMatch(l, /users\.(view|write)/, l);
  });
  test('onboarding creates accounts with staff.onboard', () => {
    for (const p of ['doctors', 'staff', 'nurses', 'lab-techs']) {
      assert.match(users, new RegExp(`router\\.post\\('/${p}', authenticate, authorize\\('admin', 'staff\\.onboard'\\)`), p);
    }
  });
  test('attendance: amend / working hours / tags are separate; nothing gates on hr.write', () => {
    assert.match(hr, /router\.post\('\/attendance\/manual', authenticate, authorize\(\.\.\.AMEND\)/);
    assert.match(hr, /router\.patch\('\/attendance\/:id', authenticate, authorize\(\.\.\.AMEND\)/);
    assert.match(hr, /router\.put\('\/work-hours\/:userId', authenticate, authorize\(\.\.\.WORKHOURS\)/);
    assert.match(hr, /router\.get\('\/tags',\s+authenticate, authorize\(\.\.\.TAGS\)/);
    assert.doesNotMatch(hr, /'hr\.write'|'hr\.credentials'/);
  });
});

describe('the gates themselves', () => {
  const other = { id: 42 };
  test('the leave tab opens for leave.view without staff files, and for staff.view without leave.view', async () => {
    assert.equal((await run(leaveViewOrSelf, { user: user('staff', [P.LEAVE_VIEW]), staffUser: other })).allowed, true);
    assert.equal((await run(leaveViewOrSelf, { user: user('staff', [P.STAFF_VIEW]), staffUser: other })).allowed, true);
    assert.equal((await run(leaveViewOrSelf, { user: user('staff'), staffUser: other })).allowed, false);
  });
  test('uploading to a colleague\'s file needs staff.documents (or the confidential drawer); your own is always fine', async () => {
    assert.equal((await run(documentUploader, { user: user('staff', [P.STAFF_VIEW]), staffUser: other })).allowed, false);
    assert.equal((await run(documentUploader, { user: user('staff', [P.STAFF_DOCUMENTS]), staffUser: other })).allowed, true);
    assert.equal((await run(documentUploader, { user: user('staff', [P.HR_CONFIDENTIAL]), staffUser: other })).allowed, true);
    assert.equal((await run(documentUploader, { user: user('nurse', [], [], 42), staffUser: other })).allowed, true);
  });
  test('a sick note on the staff file follows leave.sick', () => {
    assert.equal(canSeeHealthDocumentsOf(user('staff', [P.LEAVE_SICK]), other), true);
    assert.equal(canSeeHealthDocumentsOf(user('staff', [P.LEAVE_MANAGE], [P.LEAVE_SICK]), other), false);
    assert.equal(canSeeHealthDocumentsOf(user('staff', [P.LEAVE_VIEW]), other), false);
  });
  test('who may edit permissions at all', () => {
    assert.equal(canEditPermissions(user('staff', [P.HR_GRANT])), true);
    assert.equal(canEditPermissions(user('staff', [P.PERMISSIONS_GRANT])), true);
    assert.equal(canEditPermissions(user('doctor', [P.ADMIN_ACCESS])), false);
  });
});

describe('effective set is closed', () => {
  test('withCarried reaches a fixed point (policy → manage → view)', () => {
    const eff = effectivePermissions(user('staff', [P.LEAVE_POLICY]));
    for (const [bundle, parts] of Object.entries(BUNDLES)) {
      if (eff.has(bundle)) for (const p of parts) assert.ok(eff.has(p), `${bundle} → ${p}`);
    }
  });
});

describe('starter presets (migration 20260928000010, decision P-10)', () => {
  const { PRESETS } = require('../migrations/20260928000010-hr-starter-permission-presets');
  const { ALL_PERMISSIONS, PRESET_ROLES } = require('../constants/permissions');
  test('four presets, valid roles, only real HR capabilities, never an excluded one', () => {
    assert.deepEqual(PRESETS.map((p) => p.name), ['HR manager', 'HR officer', 'Nurse in charge', 'Line manager']);
    for (const p of PRESETS) {
      assert.ok(PRESET_ROLES.includes(p.baseRole), p.name);
      for (const cap of [...p.permissions, ...p.deniedPermissions]) {
        assert.ok(ALL_PERMISSIONS.includes(cap), `${p.name}: ${cap}`);
        assert.ok(HR_DELEGABLE.includes(cap), `${p.name}: ${cap} is HR`);
        assert.ok(!PRESET_EXCLUDED.includes(cap), `${p.name}: ${cap} excluded`);
      }
    }
  });
  test('already in stored form — what the API would store is what the migration wrote', () => {
    for (const p of PRESETS) {
      const r = reconcilePermissionLists(p.permissions, p.deniedPermissions);
      assert.deepEqual([...r.granted].sort(), [...p.permissions].sort(), p.name);
      assert.deepEqual([...r.denied].sort(), [...p.deniedPermissions].sort(), p.name);
    }
  });
  test('the HR officer records leave but never sees sick-leave details', () => {
    const officer = PRESETS.find((p) => p.name === 'HR officer');
    const u = user('staff', officer.permissions, officer.deniedPermissions);
    assert.equal(hasPermission(u, P.LEAVE_MANAGE), true);
    assert.equal(hasPermission(u, P.LEAVE_SICK), false);
    assert.equal(hasPermission(u, P.LEAVE_REGISTER), true);
  });
});
