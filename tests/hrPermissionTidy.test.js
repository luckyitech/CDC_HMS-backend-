// The one-off permissions tidy (migration 20260928000015, decision P-9 b,
// 3 Oct 2026): every broad grant's HR parts written out explicitly, so that
// nobody's access changes when users.view / users.write stop carrying them.
require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { _tidy: tidy } = require('../migrations/20260928000015-hr-permission-tidy');
const { PERMISSIONS: P, ALL_PERMISSIONS, hasPermission, passesAdminGate, BUNDLES } = require('../constants/permissions');

const user = (permissions, deniedPermissions = []) => ({ id: 1, role: 'staff', staffType: 'non_clinical', permissions, deniedPermissions });
const sorted = (a) => [...a].sort();

// What each old grant gave before the tidy (the Phase 0 bundles + legacy names).
const OLD_REACH = {
  'users.view': [P.USERS_VIEW, P.STAFF_VIEW],
  'users.write': [P.USERS_WRITE, P.USERS_VIEW, P.STAFF_VIEW, P.STAFF_EDIT, P.STAFF_ONBOARD, P.STAFF_STATUS, P.STAFF_DOCUMENTS],
  'hr.write': [P.HR_VIEW, P.HR_ATTENDANCE_AMEND, P.HR_WORKHOURS, P.HR_TAGS],
  'hr.credentials': [P.CPD_VERIFY, P.HR_EXPIRY_ALERTS],
};

describe('permissions tidy (…015)', () => {
  test('users.view / users.write no longer carry staff-file controls in code', () => {
    assert.equal(BUNDLES[P.USERS_VIEW], undefined);
    assert.equal(BUNDLES[P.USERS_WRITE], undefined);
  });
  test('every old broad grant keeps exactly what it gave, now held directly', () => {
    for (const [old, reach] of Object.entries(OLD_REACH)) {
      const t = tidy({ permissions: [old], deniedPermissions: [] });
      for (const cap of reach) assert.equal(hasPermission(user(t.permissions), cap), true, `${old} → ${cap}`);
      assert.ok(t.permissions.every((c) => ALL_PERMISSIONS.includes(c)), `${old}: only real names stored`);
    }
  });
  test('hr.write / hr.credentials leave storage; users.view / users.write stay', () => {
    const t = tidy({ permissions: ['hr.write', 'hr.credentials', 'users.write'], deniedPermissions: ['hr.credentials'] });
    assert.ok(!t.permissions.includes('hr.write') && !t.permissions.includes('hr.credentials'));
    assert.ok(t.permissions.includes('users.write'));
    assert.deepEqual(sorted(t.deniedPermissions), sorted([P.CPD_VERIFY, P.HR_EXPIRY_ALERTS]));
    assert.ok(!t.permissions.includes(P.CPD_VERIFY), 'a withdrawn part is not granted');
  });
  test('a withdrawn broad control stays withdrawn in its parts', () => {
    const t = tidy({ permissions: [P.ADMIN_ACCESS], deniedPermissions: [P.USERS_WRITE] });
    const u = user(t.permissions, t.deniedPermissions);
    for (const cap of [P.STAFF_EDIT, P.STAFF_ONBOARD, P.STAFF_STATUS, P.STAFF_DOCUMENTS]) assert.equal(passesAdminGate(u, cap), false, cap);
    assert.equal(passesAdminGate(u, P.STAFF_VIEW), true);
  });
  test('a part already withdrawn is never granted; nothing else changes', () => {
    const t = tidy({ permissions: [P.USERS_WRITE, P.LEAVE_MANAGE], deniedPermissions: [P.STAFF_STATUS] });
    assert.ok(!t.permissions.includes(P.STAFF_STATUS));
    assert.ok(t.permissions.includes(P.LEAVE_MANAGE));
    assert.deepEqual(t.deniedPermissions, [P.STAFF_STATUS]);
    assert.deepEqual(tidy({ permissions: [P.LEAVE_VIEW], deniedPermissions: [] }), { permissions: [P.LEAVE_VIEW], deniedPermissions: [] });
  });
  test('JSON strings (MariaDB) are read too, and it is idempotent', () => {
    const once = tidy({ permissions: '["users.view","hr.write"]', deniedPermissions: null });
    assert.deepEqual(tidy(once), once);
  });
});
