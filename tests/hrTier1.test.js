// HR Suite Tier 1 (B27 loose ends, 2 Oct 2026) — pure rules.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isHealthDocument, canSeeHealthDocumentsOf, HEALTH_DOCUMENT_CATEGORIES } = require('../utils/hrAccess');

const owner = { id: 10, role: 'nurse', permissions: [] };
const viewer = (permissions, extra = {}) => ({ id: 20, role: 'staff', permissions, ...extra });

describe('health documents (sick notes) on the staff file', () => {
  test('Sick Note is a health category; others are not', () => {
    assert.ok(HEALTH_DOCUMENT_CATEGORIES.includes('Sick Note'));
    assert.equal(isHealthDocument({ category: 'Sick Note' }), true);
    assert.equal(isHealthDocument({ category: 'Training Certificate' }), false);
    assert.equal(isHealthDocument(null), false);
  });
  test('the person always sees their own', () => {
    assert.equal(canSeeHealthDocumentsOf(owner, owner), true);
  });
  test('users.view alone does NOT see someone else\'s sick note', () => {
    assert.equal(canSeeHealthDocumentsOf(viewer(['users.view']), owner), false);
  });
  test('leave.manage sees it', () => {
    assert.equal(canSeeHealthDocumentsOf(viewer(['leave.manage']), owner), true);
  });
  test('hr.confidential sees it', () => {
    assert.equal(canSeeHealthDocumentsOf(viewer(['hr.confidential']), owner), true);
  });
  test('the true admin sees it', () => {
    assert.equal(canSeeHealthDocumentsOf({ id: 1, role: 'admin', permissions: [] }, owner), true);
  });
  test('a withdrawn leave.manage beats admin.access', () => {
    const v = viewer(['admin.access'], { deniedPermissions: ['leave.manage'] });
    assert.equal(canSeeHealthDocumentsOf(v, owner), false);
  });
});

// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { standing } = require('../controllers/leaveApprovalController');
const { ALERT_EVENTS } = require('../utils/hrConfig');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const u = (id, role = 'nurse', permissions = []) => ({ id, role, permissions, deniedPermissions: [], staffType: 'clinical' });
const req = { UserId: 10, participants: [{ UserId: 20, kind: 'approver', decision: 'pending' }] };

describe('a users.view holder opens a request from the staff file — read-only, redacted', () => {
  test('users.view: may open, redacted, view-only', () => {
    const s = standing(req, u(40, 'staff', ['users.view']));
    assert.equal(s.mayOpen, true);
    assert.equal(s.redact, true);
    assert.equal(s.viewOnly, true);
    assert.equal(s.isApprover, false);
  });
  test('without users.view a stranger still gets nothing', () => {
    const s = standing(req, u(40, 'staff'));
    assert.equal(s.mayOpen, false);
  });
  test('the attachment route refuses a redacted viewer', () => {
    assert.match(read('controllers', 'leaveApprovalController.js'), /if \(!st\.mayOpen \|\| st\.redact\) return error\(res, 'Leave request not found', 404\);/);
  });
  test('an approver is not view-only', () => {
    assert.equal(standing(req, u(20, 'staff', ['users.view'])).viewOnly, false);
  });
});

describe('routes added or retired on 2 Oct 2026', () => {
  const staff = read('routes', 'staff.js');
  const self = read('routes', 'hrSelf.js');
  test('PUT leave-balances is gone and setBalances with it', () => {
    assert.doesNotMatch(staff, /leave-balances'/);
    assert.doesNotMatch(read('controllers', 'leaveController.js'), /const setBalances/);
  });
  test('staff-file CPD is read-only and behind the staff-file gate', () => {
    assert.match(staff, /router\.get\('\/:employeeId\/cpd', authenticate, findStaff, adminOrSelf, cpdController\.staffList\)/);
    assert.doesNotMatch(staff, /router\.(post|patch|put|delete)\('\/:employeeId\/cpd/);
  });
  test('save the split without deciding is a PARTICIPATE route', () => {
    assert.match(read('routes', 'leave.js'), /router\.post\('\/requests\/:id\/split', authenticate, authorize\(\.\.\.PARTICIPATE\)/);
  });
  test('photo: writes need staff.edit on the staff file (users.write carries it); self routes are SELF and name nobody', () => {
    assert.match(staff, /router\.put\('\/:employeeId\/photo', authenticate, authorize\(\.\.\.STAFF_EDIT\)/);
    assert.match(staff, /router\.delete\('\/:employeeId\/photo', authenticate, authorize\(\.\.\.STAFF_EDIT\)/);
    assert.match(staff, /router\.get\('\/:employeeId\/photo', authenticate, findStaff, photoViewer/);
    for (const m of ['get', 'put', 'delete']) assert.match(self, new RegExp(`router\\.${m}\\('/photo', authenticate, authorize\\(\\.\\.\\.SELF\\)`));
  });
  test('photoUrl is no longer writable through the general staff edit', () => {
    const src = read('controllers', 'staffController.js');
    const fields = src.match(/const PROFILE_FIELDS = \[[\s\S]*?\];/)[0];
    assert.doesNotMatch(fields, /'photoUrl'/);
  });
  test('the change-request attachment is for hr.profile.approve', () => {
    assert.match(read('routes', 'hr.js'), /router\.get\('\/change-requests\/:id\/attachment', authenticate, authorize\(\.\.\.PROFILE_APPROVE\)/);
  });
  test('a new change request alerts HR through its own event', () => {
    assert.ok(ALERT_EVENTS.includes('change_request_new'));
    assert.match(read('controllers', 'hrProfileController.js'), /holdersOf\(PERMISSIONS\.HR_PROFILE_APPROVE\)\)\.filter\(\(id\) => id !== user\.id\)/);
  });
  test('the new-request notice never carries the values', () => {
    const src = read('controllers', 'hrProfileController.js');
    const block = src.slice(src.indexOf("notify('change_request_new'"), src.indexOf("notify('change_request_new'") + 400);
    assert.doesNotMatch(block, /newValue|oldValue|reason/);
  });
  test('the staff photo folder is private (never a static mount)', () => {
    assert.doesNotMatch(read('app.js'), /express\.static\([^)]*private/);
  });
});
