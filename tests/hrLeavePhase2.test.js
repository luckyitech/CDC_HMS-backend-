const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apply = require('../utils/leaveApply');
const { gateResult, PERMISSIONS, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS } = require('../constants/permissions');
const { typeForNotice, formatApplication } = require('../controllers/hrSelfLeaveController');

// =====================================================================
// B27 phase 2 (Apply) — 28 Sep 2026. No database.
//   - utils/leaveApply: what may be applied for, backdating, notice, the
//     document rule, same-role clashes (names and dates only);
//   - hr.self: every internal role by role, withdrawable, never patients;
//   - routes/hrSelf.js names no person, and the controller only ever finds
//     the caller's own requests;
//   - sick leave is never named in a notification;
//   - migration 20260928000008 refuses to narrow the ENUM over live rows.
// =====================================================================

const TYPES = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'].map((key) => ({ key, name: key }));
const policy = (over = {}) => ({
  minNoticeDays: 3,
  maxCadreAwayPerDay: 1,
  visibleTypes: ['Annual', 'Sick', 'Compassionate', 'Unpaid'],
  types: {
    Annual:        { enabled: true, minNoticeDays: 14, docRule: 'never' },
    Sick:          { enabled: true, minNoticeDays: 0, docRule: 'always' },
    Maternity:     { enabled: true, docRule: 'always' },
    Paternity:     { enabled: false, docRule: 'never' },
    Compassionate: { enabled: true, minNoticeDays: null, docRule: 'over_days', docOverDays: 2 },
    Study:         { enabled: true, docRule: 'never' },
    Unpaid:        { enabled: true, docRule: 'never' },
  },
  ...over,
});

describe('applicationCheck', () => {
  const today = '2026-09-28';
  test('an offered type with enough notice passes clean', () => {
    const r = apply.applicationCheck({ leaveType: 'Annual', start: '2026-12-07', end: '2026-12-18', today, types: TYPES, policy: policy() });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.notice, 14);
  });
  test('a request may not cross 31 December', () => {
    const r = apply.applicationCheck({ leaveType: 'Annual', start: '2026-12-30', end: '2027-01-02', today, types: TYPES, policy: policy() });
    assert.ok(r.errors.includes('CROSSES_YEAR'));
  });
  test('unknown type, switched-off type, hidden type', () => {
    assert.ok(apply.applicationCheck({ leaveType: 'Holiday', start: '2026-10-01', end: '2026-10-01', today, types: TYPES, policy: policy() }).errors.includes('BAD_TYPE'));
    assert.ok(apply.applicationCheck({ leaveType: 'Paternity', start: '2026-10-01', end: '2026-10-01', today, types: TYPES, policy: policy() }).errors.includes('TYPE_OFF'));
    assert.ok(apply.applicationCheck({ leaveType: 'Study', start: '2026-10-01', end: '2026-10-01', today, types: TYPES, policy: policy() }).errors.includes('TYPE_NOT_OFFERED'));
  });
  test('before a policy is published every active type is offered and no notice applies', () => {
    const r = apply.applicationCheck({ leaveType: 'Study', start: '2026-09-29', end: '2026-09-29', today, types: TYPES, policy: null });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(apply.offeredKeys(TYPES, null), TYPES.map((t) => t.key));
  });
  test('any type may be backdated — a warning, never an error', () => {
    for (const leaveType of ['Annual', 'Sick', 'Compassionate']) {
      const r = apply.applicationCheck({ leaveType, start: '2026-09-21', end: '2026-09-22', today, types: TYPES, policy: policy() });
      assert.deepEqual(r.errors, [], leaveType);
      assert.ok(r.warnings.includes('BACKDATED'), leaveType);
    }
  });
  test('short notice uses the type\'s own notice, else the clinic\'s', () => {
    assert.ok(apply.applicationCheck({ leaveType: 'Annual', start: '2026-10-05', end: '2026-10-05', today, types: TYPES, policy: policy() }).warnings.includes('SHORT_NOTICE'));
    // Compassionate has no notice of its own → the clinic's 3 days.
    assert.ok(apply.applicationCheck({ leaveType: 'Compassionate', start: '2026-09-30', end: '2026-09-30', today, types: TYPES, policy: policy() }).warnings.includes('SHORT_NOTICE'));
    assert.deepEqual(apply.applicationCheck({ leaveType: 'Compassionate', start: '2026-10-01', end: '2026-10-01', today, types: TYPES, policy: policy() }).warnings, []);
    // Sick asks for none.
    assert.deepEqual(apply.applicationCheck({ leaveType: 'Sick', start: '2026-09-28', end: '2026-09-28', today, types: TYPES, policy: policy() }).warnings, []);
  });
});

describe('documentNeededFor', () => {
  test('always / over N days / never / no policy', () => {
    assert.equal(apply.documentNeededFor(policy(), 'Sick', 1), true);
    assert.equal(apply.documentNeededFor(policy(), 'Compassionate', 2), false);
    assert.equal(apply.documentNeededFor(policy(), 'Compassionate', 2.5), true);
    assert.equal(apply.documentNeededFor(policy(), 'Annual', 20), false);
    assert.equal(apply.documentNeededFor(null, 'Sick', 5), false);
  });
});

describe('clashes — same role, names and dates only', () => {
  const others = [
    { userId: 5, name: 'Amina Yusuf', startDate: '2026-12-14', endDate: '2026-12-16', leaveType: 'Sick', reason: 'x' },
    { userId: 6, name: 'Farah Sherdel', startDate: '2026-11-01', endDate: '2026-11-03' },
  ];
  test('overlapping colleagues are clipped to the request', () => {
    const r = apply.clashes({ start: '2026-12-07', end: '2026-12-18', others, maxPerDay: 1 });
    assert.deepEqual(r.people, [{ name: 'Amina Yusuf', from: '2026-12-14', to: '2026-12-16' }]);
    assert.deepEqual(r.overLimit, ['2026-12-14', '2026-12-15', '2026-12-16']);
  });
  test('the result carries no type or reason', () => {
    const r = apply.clashes({ start: '2026-12-07', end: '2026-12-18', others, maxPerDay: 1 });
    assert.equal(JSON.stringify(r).includes('Sick'), false);
    assert.equal(JSON.stringify(r).includes('reason'), false);
  });
  test('no limit set → nothing is over it; holidays are skipped', () => {
    assert.deepEqual(apply.clashes({ start: '2026-12-07', end: '2026-12-18', others, maxPerDay: null }).overLimit, []);
    const r = apply.clashes({ start: '2026-12-14', end: '2026-12-16', others, maxPerDay: 1, skipDates: new Set(['2026-12-15']) });
    assert.deepEqual(r.overLimit, ['2026-12-14', '2026-12-16']);
  });
});

describe('hr.self', () => {
  const SELF = ['doctor', 'staff', 'lab', 'nurse', 'admin', 'hr.self'];
  const u = (role, extra = {}) => ({ id: 9, role, permissions: [], deniedPermissions: [], staffType: 'clinical', ...extra });
  test('every internal role by role; patients never', () => {
    for (const role of ['doctor', 'staff', 'lab', 'nurse', 'admin']) assert.equal(gateResult(u(role), SELF), 'ok', role);
    assert.notEqual(gateResult(u('patient'), SELF), 'ok');
  });
  test('withdrawing hr.self stops one person', () => {
    assert.equal(gateResult(u('nurse', { deniedPermissions: ['hr.self'] }), SELF), 'denied');
  });
  test('defined, covered by admin.access, and on the HR Suite card as "My record"', () => {
    assert.equal(PERMISSIONS.HR_SELF, 'hr.self');
    assert.ok(ADMIN_ACCESS_COVERS.includes('hr.self'));
    const hr = PERMISSION_GROUPS.find((g) => g.key === 'hr');
    const area = hr.areas.find((a) => a.access === 'hr.self');
    assert.equal(area.name, 'My record');
  });
});

describe('routes/hrSelf.js — no route names a person', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hrSelf.js'), 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => m[2]);
  test('only /leave…, /leave/:id…, /approvers and (phase 4) my profile — never a person', () => {
    assert.ok(routes.length >= 9);
    for (const r of routes) {
      assert.match(r, /^\/(leave(\/preview|\/:id(\/(reply|withdraw|cancel-request|attachment))?)?|approvers|contact|change-requests(\/:id\/withdraw)?)?$/, r);
    }
  });
  test('every route is behind authorize(...SELF)', () => {
    const lines = src.split('\n').filter((l) => /router\.(get|post|put|patch|delete)\(/.test(l));
    for (const l of lines) assert.ok(l.includes('authenticate, authorize(...SELF)'), l);
  });
  test('app.js mounts it before /api/hr', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(app.indexOf("'/api/hr/me'") > -1 && app.indexOf("'/api/hr/me'") < app.indexOf("'/api/hr',"));
  });
});

describe('controllers/hrSelfLeaveController.js — ownership is the query', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'hrSelfLeaveController.js'), 'utf8');
  test('every request lookup by id is scoped to the caller', () => {
    const finds = [...src.matchAll(/StaffLeave\.findOne\(\{ where: \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(finds.length >= 1);
    for (const f of finds) assert.match(f, /UserId: req\.user\.id/);
    // Documents offered as attachments must be the caller's own too.
    const docs = [...src.matchAll(/StaffDocument\.findOne\(\{ where: \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(docs.length >= 2);
    for (const d of docs) assert.match(d, /UserId: (me\.id|req\.user\.id)/);
  });
  test('no req.params other than :id, no userId from the body used as the owner', () => {
    const params = [...src.matchAll(/req\.params\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(params)], ['id']);
    assert.equal(/UserId: (req\.body|body)\./.test(src), false);
  });
});

describe('notifications never name sick leave', () => {
  test('a private type reads "Leave"; others their name', () => {
    assert.equal(typeForNotice('Sick', { Sick: 'Sick' }), 'Leave');
    assert.equal(typeForNotice('Annual', { Annual: 'Annual' }), 'Annual leave');
  });
  test('no reason, answer or note is passed to hrNotify', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'hrSelfLeaveController.js'), 'utf8');
    const calls = src.split('hrNotify.notify(').slice(1).map((c) => c.slice(0, c.indexOf('});')));
    assert.ok(calls.length >= 5);
    for (const c of calls) {
      assert.equal(/reason|note|body\.contact/.test(c.replace(/body:/g, '')), false, c);
      assert.equal(c.includes('result.leaveType}'), false, 'a raw type key in the text');
    }
  });
});

describe('formatApplication', () => {
  const leave = {
    id: 1, leaveType: 'Sick', startDate: '2026-09-21', endDate: '2026-09-22', days: '2.00', status: 'Pending',
    reason: 'Migraine', breakdown: JSON.stringify({ documentNeeded: true, backdated: true, groups: [] }),
    participants: [], events: [], charges: [{ status: 'active', leaveType: 'Sick', days: '2.00' }], attachment: null,
  };
  test('the applicant sees their own sick leave in full, document owed', () => {
    const f = formatApplication(leave, { typeNames: { Sick: 'Sick' }, today: '2026-09-28' });
    assert.equal(f.leaveType, 'Sick');
    assert.equal(f.reason, 'Migraine');
    assert.equal(f.days, 2);
    assert.equal(f.flags.documentOwed, true);
    assert.equal(f.can.withdraw, true);
    assert.equal(f.can.addDocument, true);
  });
  test('a redacted viewer (phase 3) sees "Private" and no reason', () => {
    const f = formatApplication(leave, { typeNames: { Sick: 'Sick' }, redact: true, today: '2026-09-28' });
    assert.equal(f.leaveType, 'Private');
    assert.equal(f.reason, null);
    assert.equal(f.charges[0].leaveType, 'Private');
  });
});

describe('migration 20260928000008', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260928000008-leave-event-document-added.js'), 'utf8');
  test('adds document_added and its down refuses over live rows', () => {
    assert.ok(src.includes("'document_added'"));
    assert.match(src, /throw new Error\(`\[20260928000008\] down refused/);
    assert.match(src, /toLowerCase\(\) === name\.toLowerCase\(\)/);
  });
  test('the model knows the new type', () => {
    const LeaveEvent = require('../models/LeaveEvent');
    assert.ok(LeaveEvent.EVENT_TYPES.includes('document_added'));
  });
});
