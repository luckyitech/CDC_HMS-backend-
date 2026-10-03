// HR Tier 3 Phase 3 — onboarding checklists (T3-4 = a, O-1…O-8). Pure: the
// rules in utils/onboarding, the frozen starter template in migration …012,
// the two new controls, and the wizard's blank start / HR-grantor rule.
// DB behaviour is proven by the scratch e2e harness.
require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../utils/onboarding');
const {
  PERMISSIONS: P, STAFF_TYPES, SCOPABLE, HR_DELEGABLE, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, PRESET_EXCLUDED,
} = require('../constants/permissions');
const { resolveAccessAtCreation } = require('../controllers/userController');

describe('the controls (O-6)', () => {
  test('hr.onboarding: scopable, delegable, admin access', () => {
    assert.ok(SCOPABLE.includes(P.HR_ONBOARDING));
    assert.ok(HR_DELEGABLE.includes(P.HR_ONBOARDING));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_ONBOARDING));
    assert.ok(!PRESET_EXCLUDED.includes(P.HR_ONBOARDING));
  });
  test('hr.onboarding.templates: clinic-wide, delegable, admin access', () => {
    assert.ok(!SCOPABLE.includes(P.HR_ONBOARDING_TEMPLATES));
    assert.ok(HR_DELEGABLE.includes(P.HR_ONBOARDING_TEMPLATES));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_ONBOARDING_TEMPLATES));
  });
  test('both on the People and staff files card', () => {
    const g = PERMISSION_GROUPS.find((x) => x.key === 'hr-people');
    assert.ok(g.areas.some((a) => a.access === P.HR_ONBOARDING));
    assert.ok(g.areas.some((a) => a.access === P.HR_ONBOARDING_TEMPLATES));
  });
  test('staff-file routes ask the scope', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/staff.js'), 'utf8');
    assert.match(src, /const onb = \[authenticate, authorize\(\.\.\.ONBOARDING\), findStaff, inStaffScope\('hr\.onboarding'\)\]/);
  });
  test('the list asks the scope', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/onboarding.js'), 'utf8');
    assert.match(src, /hrScope\.scopeWhere\(user, PERMISSIONS\.HR_ONBOARDING\)/);
  });
});

describe('templates (O-2)', () => {
  test('the migration\'s frozen starter lines equal the rules\' starter template', () => {
    const mig = require('../migrations/20260928000012-hr-onboarding-checklists');
    for (const role of R.ROLES) assert.deepEqual(mig._starterTemplate(role), R.starterTemplate(role), role);
  });
  test('licence only for clinical roles; every auto key is known', () => {
    assert.ok(R.starterTemplate('nurse').some((x) => x.autoKey === 'licence'));
    assert.ok(!R.starterTemplate('staff').some((x) => x.autoKey === 'licence'));
    for (const role of R.ROLES) R.starterTemplate(role).forEach((x) => assert.ok(x.autoKey === null || R.AUTO_KEYS.includes(x.autoKey)));
  });
  test('template writes are cleaned', () => {
    assert.equal(R.cleanTemplateItem({ label: 'x', role: 'nurse' }).error, 'LABEL_REQUIRED');
    assert.equal(R.cleanTemplateItem({ label: 'Badge', role: 'nurse', autoKey: 'nope' }).error, 'BAD_AUTO_KEY');
    assert.equal(R.cleanTemplateItem({ label: 'Badge', role: 'nurse', dueDays: 400 }).error, 'BAD_DUE_DAYS');
    assert.equal(R.cleanTemplateItem({ label: 'Badge', role: 'pharmacist' }).error, 'BAD_ROLE');
    assert.deepEqual(R.cleanTemplateItem({ label: ' Badge ', role: 'nurse', dueDays: '7', autoKey: '' }).value,
      { label: 'Badge', autoKey: null, dueDays: 7, role: 'nurse' });
    assert.deepEqual(R.cleanTemplateItem({ status: 'archived' }, { partial: true }).value, { status: 'archived' });
  });
  test('due dates count from the start date (or today)', () => {
    assert.equal(R.dueDateFor(7, '2026-10-01', '2026-10-03'), '2026-10-08');
    assert.equal(R.dueDateFor(7, null, '2026-10-03'), '2026-10-10');
    assert.equal(R.dueDateFor(null, '2026-10-01', '2026-10-03'), null);
    assert.equal(R.addDays('2026-12-30', 3), '2027-01-02');
  });
});

describe('progress (O-4, O-5)', () => {
  const facts = { contract: true, photo: false };
  const items = [
    { autoKey: 'contract', dueDate: '2026-10-01', status: 'active' },
    { autoKey: 'photo', dueDate: '2026-10-01', status: 'active' },
    { autoKey: null, doneAt: new Date(), dueDate: null, status: 'active' },
    { autoKey: null, doneAt: null, dueDate: '2026-10-10', status: 'active' },
    { autoKey: null, doneAt: null, dueDate: '2026-09-01', status: 'removed' },
  ];
  test('automatic items follow the facts; manual items follow the tick; removed ignored', () => {
    assert.deepEqual(R.progress(items, facts, '2026-10-03'), { total: 4, done: 2, overdue: 1, complete: false, percent: 50 });
  });
  test('an automatic item cannot be done by a stray doneAt', () => {
    assert.equal(R.itemState({ autoKey: 'photo', doneAt: new Date() }, { photo: false }, '2026-10-03').done, false);
  });
  test('complete when every active item is done; an empty list never is', () => {
    assert.equal(R.progress([{ autoKey: 'contract', status: 'active' }], { contract: true }, '2026-10-03').complete, true);
    assert.equal(R.progress([], {}, '2026-10-03').complete, false);
  });
});

describe('the wizard: blank start and HR grantors (O-1)', () => {
  const user = (role, permissions = [], id = 1) => ({ id, role, permissions, deniedPermissions: [] });
  const onboarder = user('staff', [P.STAFF_ONBOARD]);
  const hrManager = user('staff', [P.STAFF_ONBOARD, P.HR_GRANT, P.LEAVE_VIEW, P.HR_VIEW, P.HR_ONBOARDING]);
  const resolve = (body, caller, preset = null, role = 'nurse') => resolveAccessAtCreation({ body, role, caller, preset });
  const BLANK = { staffType: STAFF_TYPES.CLINICAL, permissions: [], deniedPermissions: [] };

  test('a blank start (what the wizard sends) is allowed for anyone who may onboard', () => {
    const r = resolve(BLANK, onboarder);
    assert.ok(r.access, JSON.stringify(r));
    assert.deepEqual(r.access.permissions, []);
    assert.equal(r.access.viaHrGrant, false);
  });
  test('a blank start that is not clinical still needs a key-holder', () => {
    assert.equal(resolve({ ...BLANK, staffType: STAFF_TYPES.NON_CLINICAL }, onboarder).code, 403);
  });
  test('an HR grantor may tick HR controls they hold', () => {
    const r = resolve({ ...BLANK, permissions: [P.LEAVE_VIEW, P.HR_ONBOARDING] }, hrManager);
    assert.ok(r.access, JSON.stringify(r));
    assert.equal(r.access.viaHrGrant, true);
    assert.deepEqual(r.access.hrGiven.sort(), [P.HR_ONBOARDING, P.LEAVE_VIEW].sort());
  });
  test('…but not a control they do not hold', () => {
    const r = resolve({ ...BLANK, permissions: [P.LEAVE_SICK] }, hrManager);
    assert.equal(r.code, 403);
    assert.equal(r.extra.code, 'NOT_HELD');
  });
  test('…nor anything outside the HR Suite', () => {
    const r = resolve({ ...BLANK, permissions: [P.STOCK_ACCESS] }, hrManager);
    assert.equal(r.code, 403);
    assert.equal(r.extra.code, 'NOT_DELEGABLE');
  });
  test('…nor confidential documents or hr.grant', () => {
    assert.equal(resolve({ ...BLANK, permissions: [P.HR_CONFIDENTIAL] }, hrManager).extra.code, 'NOT_DELEGABLE');
    assert.equal(resolve({ ...BLANK, permissions: [P.HR_GRANT] }, hrManager).extra.code, 'NOT_DELEGABLE');
  });
  test('…nor the staff type, nor an admin account', () => {
    assert.equal(resolve({ ...BLANK, staffType: STAFF_TYPES.NON_CLINICAL, permissions: [P.LEAVE_VIEW] }, hrManager).code, 403);
    assert.equal(resolve({ ...BLANK, permissions: [P.LEAVE_VIEW] }, hrManager, null, 'admin').code, 403);
  });
  test('an HR grantor may add HR controls on top of a preset', () => {
    const preset = { id: 3, name: 'Nurse', status: 'active', baseRole: 'nurse', staffType: STAFF_TYPES.CLINICAL, permissions: [P.STOCK_ACCESS], deniedPermissions: [] };
    const r = resolve({ presetId: 3, staffType: STAFF_TYPES.CLINICAL, permissions: [P.STOCK_ACCESS, P.HR_VIEW], deniedPermissions: [] }, hrManager, preset);
    assert.ok(r.access, JSON.stringify(r));
    assert.deepEqual(r.access.hrGiven, [P.HR_VIEW]);
  });
  test('a non-grantor still cannot tick anything', () => {
    assert.equal(resolve({ ...BLANK, permissions: [P.LEAVE_VIEW] }, onboarder).code, 403);
  });
  test('staffController still exposes the same hrGrantRefusal', () => {
    assert.equal(require('../controllers/staffController').hrGrantRefusal, require('../utils/hrGrant').hrGrantRefusal);
  });
});
