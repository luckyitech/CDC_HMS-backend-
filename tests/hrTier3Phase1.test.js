// HR Suite Tier 3, Phase 1 (2 Oct 2026) — departments and positions as lists,
// and department scopes on the HR controls (P-1/P-7/P-8, L-1…L-8).
// Pure: the scope rules (utils/hrScope), the list normaliser, preset scopes
// and the route wiring. The database side is proven end-to-end against a
// scratch MariaDB (see the session doc).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PERMISSIONS: P, SCOPABLE, HR_DELEGABLE, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, PRESET_EXCLUDED } = require('../constants/permissions');
const {
  resolveScope, inScope, withinScope, cleanSpec, specOfRows, rowsOfSpec, scopeOfSpec, mayBeScoped,
} = require('../utils/hrScope');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const user = (role, permissions = [], deniedPermissions = [], id = 1) => ({ id, role, permissions, deniedPermissions });
const ids = (scope) => [...scope.departmentIds].sort();
const LAB = 3; const NURSING = 5; const FRONT = 7;

describe('the vocabulary', () => {
  test('hr.lists is an HR control, delegable, covered by admin access, never scoped', () => {
    assert.ok(HR_DELEGABLE.includes(P.HR_LISTS));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_LISTS));
    assert.ok(!SCOPABLE.includes(P.HR_LISTS));
  });
  test('every scopable control is an HR control on the Permissions tab', () => {
    const hrCaps = PERMISSION_GROUPS.filter((g) => g.hr).flatMap((g) => g.areas).map((a) => a.access);
    for (const cap of SCOPABLE) assert.ok(hrCaps.includes(cap), cap);
  });
  test('clinic-wide rules are never scopable', () => {
    for (const cap of [P.LEAVE_POLICY, P.LEAVE_HOLIDAYS, P.HR_SETTINGS, P.HR_TAGS, P.STAFF_ONBOARD, P.LEAVE_APPROVE, P.HR_SELF, P.HR_CHECKIN]) {
      assert.ok(!SCOPABLE.includes(cap), cap);
    }
  });
});

describe('resolveScope — what a person reaches', () => {
  test('no grant → nothing; a grant with no rows → all staff (deploy day: nothing changes)', () => {
    assert.equal(resolveScope({ user: user('staff'), capability: P.LEAVE_VIEW }).all, false);
    assert.equal(ids(resolveScope({ user: user('staff'), capability: P.LEAVE_VIEW })).length, 0);
    assert.equal(resolveScope({ user: user('staff', [P.LEAVE_VIEW]), capability: P.LEAVE_VIEW }).all, true);
  });
  test('own department follows the holder; named departments are listed', () => {
    const own = resolveScope({ user: user('nurse', [P.HR_VIEW]), capability: P.HR_VIEW,
      rows: [{ capability: P.HR_VIEW, kind: 'own' }], ownDepartmentId: NURSING });
    assert.deepEqual([own.all, ids(own)], [false, [NURSING]]);
    const moved = resolveScope({ user: user('nurse', [P.HR_VIEW]), capability: P.HR_VIEW,
      rows: [{ capability: P.HR_VIEW, kind: 'own' }], ownDepartmentId: LAB });
    assert.deepEqual(ids(moved), [LAB]);
    const named = resolveScope({ user: user('staff', [P.HR_VIEW]), capability: P.HR_VIEW,
      rows: [{ capability: P.HR_VIEW, kind: 'department', departmentId: LAB }, { capability: P.HR_VIEW, kind: 'department', departmentId: FRONT }] });
    assert.deepEqual(ids(named), [LAB, FRONT].sort());
  });
  test('own department with no department on the holder\'s file reaches nobody', () => {
    const s = resolveScope({ user: user('nurse', [P.HR_VIEW]), capability: P.HR_VIEW, rows: [{ capability: P.HR_VIEW, kind: 'own' }], ownDepartmentId: null });
    assert.deepEqual([s.all, ids(s)], [false, []]);
  });
  test('a carried control follows the scope of what carries it (L-5)', () => {
    const u = user('staff', [P.LEAVE_MANAGE]);
    const rows = [{ capability: P.LEAVE_MANAGE, kind: 'department', departmentId: LAB }];
    assert.deepEqual(ids(resolveScope({ user: u, capability: P.LEAVE_SICK, rows })), [LAB]);
    assert.deepEqual(ids(resolveScope({ user: u, capability: P.LEAVE_VIEW, rows })), [LAB]);
  });
  test('the widest source wins', () => {
    const u = user('staff', [P.LEAVE_MANAGE, P.LEAVE_VIEW]);
    const rows = [{ capability: P.LEAVE_MANAGE, kind: 'department', departmentId: LAB }];
    assert.equal(resolveScope({ user: u, capability: P.LEAVE_VIEW, rows }).all, true);   // leave.view ticked with no limit
    const both = resolveScope({ user: u, capability: P.LEAVE_VIEW, rows: [...rows, { capability: P.LEAVE_VIEW, kind: 'department', departmentId: FRONT }] });
    assert.deepEqual(ids(both), [LAB, FRONT].sort());
  });
  test('legacy names and broad Administration controls are all staff', () => {
    assert.equal(resolveScope({ user: user('staff', ['hr.write']), capability: P.HR_VIEW,
      rows: [{ capability: 'hr.write', kind: 'department', departmentId: LAB }] }).all, true);
    assert.equal(resolveScope({ user: user('staff', [P.USERS_VIEW]), capability: P.STAFF_VIEW }).all, true);
  });
  test('the true admin and full administrator access are always all staff', () => {
    const rows = [{ capability: P.STAFF_VIEW, kind: 'department', departmentId: LAB }];
    assert.equal(resolveScope({ user: user('admin'), capability: P.STAFF_VIEW, rows }).all, true);
    assert.equal(resolveScope({ user: user('doctor', [P.ADMIN_ACCESS, P.STAFF_VIEW]), capability: P.STAFF_VIEW, rows }).all, true);
  });
  test('a withdrawal beats every scope', () => {
    const s = resolveScope({ user: user('staff', [P.LEAVE_MANAGE], [P.LEAVE_SICK]), capability: P.LEAVE_SICK });
    assert.deepEqual([s.all, ids(s)], [false, []]);
  });
  test('mayBeScoped lets unscoped people skip the database', () => {
    assert.equal(mayBeScoped(user('admin'), P.STAFF_VIEW), false);
    assert.equal(mayBeScoped(user('doctor', [P.ADMIN_ACCESS]), P.LEAVE_SICK), false);
    assert.equal(mayBeScoped(user('staff', [P.USERS_VIEW]), P.STAFF_VIEW), false);
    assert.equal(mayBeScoped(user('staff', [P.LEAVE_MANAGE]), P.LEAVE_SICK), true);
    assert.equal(mayBeScoped(user('staff', [P.LEAVE_VIEW]), P.HR_SETTINGS), false);
  });
});

describe('inScope / withinScope', () => {
  const lab = { all: false, departmentIds: new Set([LAB]) };
  const all = { all: true, departmentIds: new Set() };
  test('nobody without a department is in a limited scope (P-8)', () => {
    assert.equal(inScope(lab, null), false);
    assert.equal(inScope(all, null), true);
    assert.equal(inScope(lab, LAB), true);
    assert.equal(inScope(lab, FRONT), false);
  });
  test('a grantor gives no wider than they hold (L-8)', () => {
    assert.equal(withinScope(lab, all), true);
    assert.equal(withinScope(all, lab), false);
    assert.equal(withinScope({ all: false, departmentIds: new Set([LAB, FRONT]) }, lab), false);
    assert.equal(withinScope(scopeOfSpec({ kind: 'own' }, LAB), lab), true);
    assert.equal(withinScope(scopeOfSpec({ kind: 'own' }, FRONT), lab), false);
  });
});

describe('the scope spec the Permissions tab sends', () => {
  test('cleanSpec accepts the three shapes and refuses nonsense', () => {
    assert.deepEqual(cleanSpec({ kind: 'all' }), { kind: 'all' });
    assert.deepEqual(cleanSpec({ kind: 'own', departmentIds: [1] }), { kind: 'own' });
    assert.deepEqual(cleanSpec({ kind: 'departments', departmentIds: ['7', 3, 3, -1, 'x'] }), { kind: 'departments', departmentIds: [3, 7] });
    assert.equal(cleanSpec({ kind: 'departments', departmentIds: [] }), null);
    assert.equal(cleanSpec({ kind: 'everyone' }), null);
    assert.equal(cleanSpec(null), null);
  });
  test('rows ↔ spec round-trip', () => {
    for (const spec of [{ kind: 'all' }, { kind: 'own' }, { kind: 'departments', departmentIds: [3, 7] }]) {
      assert.deepEqual(specOfRows(rowsOfSpec(spec)), spec);
    }
  });
});

describe('lists', () => {
  test('free text groups ignoring case, spaces and punctuation', () => {
    const { normalise } = require('../services/staffLists');
    assert.equal(normalise('  Diabetes  Clinic '), 'diabetes clinic');
    assert.equal(normalise('diabetes-clinic.'), 'diabetes clinic');
    assert.equal(normalise(null), '');
  });
  test('department and position are written only through the lists', () => {
    const staff = read('controllers', 'staffController.js');
    assert.doesNotMatch(staff.match(/const PROFILE_FIELDS = \[[\s\S]*?\];/)[0], /'department'|'position'/);
    assert.match(staff, /staffLists\.resolveListFields\(/);
    assert.match(read('controllers', 'userController.js'), /staffLists\.resolveListFields\(/);
  });
  test('the list routes: read for every member of staff, change for hr.lists', () => {
    const hr = read('routes', 'hr.js');
    assert.match(hr, /const LISTS_READ = \['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr\.lists'\]/);
    assert.match(hr, /router\.post\('\/lists\/:list', authenticate, authorize\(\.\.\.LISTS\)/);
    assert.match(hr, /router\.patch\('\/lists\/:list\/:id', authenticate, authorize\(\.\.\.LISTS\)/);
    assert.match(hr, /router\.post\('\/lists\/tidy', authenticate, authorize\(\.\.\.LISTS\)/);
  });
});

describe('preset scopes', () => {
  const { cleanPresetScopes, validatePresetPayload } = require('../controllers/permissionPresetController');
  test('only "own department", only for controls the preset grants', () => {
    assert.deepEqual(
      cleanPresetScopes({ 'staff.view': { kind: 'own' }, 'hr.view': { kind: 'departments', departmentIds: [3] }, 'leave.view': { kind: 'own' }, 'hr.settings': { kind: 'own' } }, ['staff.view', 'hr.view', 'hr.settings']),
      { 'staff.view': { kind: 'own' } },
    );
    assert.deepEqual(cleanPresetScopes('{"hr.view":{"kind":"own"}}', ['hr.view']), { 'hr.view': { kind: 'own' } });
  });
  test('a preset payload carries its scopes', () => {
    const { fields } = validatePresetPayload({ name: 'Ward lead', baseRole: 'nurse', permissions: ['hr.view'], scopes: { 'hr.view': { kind: 'own' } } });
    assert.deepEqual(fields.scopes, { 'hr.view': { kind: 'own' } });
    assert.ok(PRESET_EXCLUDED.includes(P.HR_GRANT));
  });
  test('the two lead presets get own-department limits from migration 011', () => {
    const src = read('migrations', '20260928000011-hr-departments-positions-scopes.js');
    assert.match(src, /'Nurse in charge': \{/);
    assert.match(src, /'Line manager': \{/);
    assert.match(src, /createdById IS NULL AND updatedById IS NULL AND appliedCount = 0/);
  });
});

describe('every HR list and action asks the scope', () => {
  const staffRoutes = read('routes', 'staff.js');
  test('staff-file actions check scope after findStaff', () => {
    for (const [route, cap] of [
      ["router.put('/:employeeId',", 'staff.edit'],
      ["router.patch('/:employeeId/status',", 'staff.status'],
      ["router.delete('/:employeeId',", 'staff.status'],
      ["router.patch('/:employeeId/restore',", 'staff.status'],
      ["router.get('/:employeeId/activity',", 'staff.view'],
      ["router.put('/:employeeId/required-approvers',", 'leave.required'],
      ["router.post('/:employeeId/leaves',", 'leave.manage'],
      ["router.put('/:employeeId/photo',", 'staff.edit'],
      ["router.patch('/:employeeId/documents/:id',", 'staff.documents'],
    ]) {
      const line = staffRoutes.split('\n').find((l) => l.startsWith(route));
      assert.ok(line, route);
      assert.match(line, new RegExp(`findStaff, inStaffScope\\('${cap.replace('.', '\\.')}'\\)`), route);
    }
  });
  test('the controllers that list people filter by scope', () => {
    const checks = {
      'staffController.js': /userIdsInScope\(req\.user, PERMISSIONS\.STAFF_VIEW\)/,
      'hrAttendanceController.js': /filterInScope\(req\.user, PERMISSIONS\.HR_VIEW/,
      'hrWorkHoursController.js': /filterInScope\(req\.user, \[PERMISSIONS\.HR_VIEW, PERMISSIONS\.HR_WORKHOURS\]/,
      'hrProfileController.js': /scopeWhere\(req\.user, PERMISSIONS\.HR_PROFILE_APPROVE\)/,
      'cpdController.js': /scopeWhere\(req\.user, PERMISSIONS\.CPD_VERIFY\)/,
      'leaveSettingsController.js': /filterInScope\(req\.user, PERMISSIONS\.LEAVE_ENTITLEMENTS/,
      'leaveApprovalController.js': /scopeOf\(req\.user, PERMISSIONS\.LEAVE_REGISTER\)/,
      'leaveCalendarController.js': /scopeOf\(req\.user, PERMISSIONS\.LEAVE_SICK\)/,
    };
    for (const [file, re] of Object.entries(checks)) assert.match(read('controllers', file), re, file);
  });
  test('alerts about a person go only to holders whose scope covers them (L-6)', () => {
    assert.match(read('services', 'expiryReminders.js'), /hrScope\.holdersFor\(PERMISSIONS\.HR_EXPIRY_ALERTS, userId\)/);
    assert.match(read('controllers', 'hrProfileController.js'), /hrScope\.holdersFor\(PERMISSIONS\.HR_PROFILE_APPROVE, user\.id\)/);
  });
  test('out of scope reads as not found, never access denied', () => {
    assert.match(read('middleware', 'staffScope.js'), /error\(res, 'Staff member not found', 404\)/);
  });
  test('PermissionScopes has one writer', () => {
    const writers = ['controllers', 'services'].flatMap((dir) => fs.readdirSync(path.join(__dirname, '..', dir))
      .filter((f) => /PermissionScope\.(create|bulkCreate|destroy|update)\(/.test(read(dir, f))).map((f) => `${dir}/${f}`));
    assert.deepEqual(writers, ['services/hrScope.js']);
  });
});
