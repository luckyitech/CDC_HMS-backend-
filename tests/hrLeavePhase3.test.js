const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { employmentFlips } = require('../utils/leaveWorkflow');
const { standing } = require('../controllers/leaveApprovalController');
const { describe: msg } = require('../utils/leaveApply');

// =====================================================================
// B27 phase 3 (Approve) — 28 Sep 2026. No database.
//   - who may open a request, and who sees a private type (standing);
//   - the approvals routes' gates; record on behalf is leave.manage;
//     the old staff-file decide route is gone;
//   - notifications carry no reason, note or type;
//   - the On Leave sweep never undoes a status HR set by hand.
// =====================================================================

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const user = (id, role = 'nurse', permissions = []) => ({ id, role, permissions, deniedPermissions: [], staffType: 'clinical' });
const leave = (participants = [], extra = {}) => ({
  UserId: 10,
  participants: participants.map(([UserId, kind, decision = 'pending']) => ({ UserId, kind, decision })),
  ...extra,
});

describe('standing — who may open, who sees a private type', () => {
  const l = leave([[20, 'approver'], [30, 'acknowledger']]);
  test('the applicant opens it and sees everything', () => {
    const s = standing(l, user(10));
    assert.equal(s.mayOpen, true); assert.equal(s.redact, false); assert.equal(s.isApplicant, true);
  });
  test('an approver sees everything', () => {
    const s = standing(l, user(20));
    assert.equal(s.mayOpen, true); assert.equal(s.redact, false); assert.equal(s.isApprover, true);
  });
  test('an acknowledger opens it redacted (sick leave is health data)', () => {
    const s = standing(l, user(30));
    assert.equal(s.mayOpen, true); assert.equal(s.redact, true); assert.equal(s.isAcknowledger, true);
  });
  test('a stranger may not open it', () => {
    assert.equal(standing(l, user(40)).mayOpen, false);
  });
  test('leave.manage opens anything, unredacted, but is not an approver', () => {
    const s = standing(l, user(40, 'nurse', ['leave.manage']));
    assert.equal(s.mayOpen, true); assert.equal(s.redact, false); assert.equal(s.isApprover, false);
  });
  test('a request with no approvers is legacy (pre-B27)', () => {
    assert.equal(standing(leave([]), user(40, 'admin')).legacy, true);
    assert.equal(standing(l, user(40, 'admin')).legacy, false);
  });
});

describe('routes', () => {
  test('approvals: every inbox/requests route behind PARTICIPATE (every internal role + the two caps)', () => {
    const src = read('routes', 'leave.js');
    assert.match(src, /const PARTICIPATE = \['doctor', 'staff', 'lab', 'nurse', 'admin', 'leave\.approve', 'leave\.manage'\];/);
    const lines = src.split('\n').filter((l) => /^router\.\w+\('\/(inbox|requests)/.test(l));
    assert.ok(lines.length >= 6);
    for (const l of lines) assert.match(l, /authenticate, authorize\(\.\.\.PARTICIPATE\)/, l);
  });
  test('record on behalf and its preview are leave.manage; the old decide route is gone', () => {
    const src = read('routes', 'staff.js');
    assert.match(src, /router\.post\('\/:employeeId\/leaves', authenticate, authorize\(\.\.\.LEAVE_MANAGE\)/);
    assert.match(src, /router\.post\('\/:employeeId\/leaves\/preview', authenticate, authorize\(\.\.\.LEAVE_MANAGE\)/);
    assert.doesNotMatch(src, /router\.patch\('\/:employeeId\/leaves\/:id'/);
    assert.doesNotMatch(read('controllers', 'leaveController.js'), /\bconst decide = /);
  });
  test('record on behalf refuses your own file', () => {
    assert.match(read('controllers', 'leaveController.js'), /staffUser\.id === req\.user\.id[\s\S]{0,200}OWN_LEAVE/);
  });
});

describe('deciding', () => {
  const src = read('controllers', 'leaveApprovalController.js');
  test('declining or asking needs a note; nobody decides their own', () => {
    assert.match(src, /decision !== 'approve' && !note/);
    assert.match(src, /st\.isApplicant\) return error\(res, 'You cannot decide your own leave'/);
  });
  test('only a leave.approve holder changes the split, and only when approving', () => {
    assert.match(src, /Array\.isArray\(req\.body\?\.charges\) && decision === 'approve'/);
    assert.match(src, /if \(!holdsApprove\(req\.user\)\)[\s\S]{0,160}NO_SPLIT_RIGHT/);
  });
  test('a doctor\'s slots are blocked only when the year\'s policy says so', () => {
    assert.match(src, /blockDoctorSlots: policy \? policy\.blockDoctorSlots : true/);
    assert.match(read('controllers', 'leaveController.js'), /staffUser\.role === 'doctor' && blockDoctorSlots/);
  });
  test('notifications carry no reason, note, question or type', () => {
    const calls = src.split('hrNotify.notify(').slice(1).map((c) => c.slice(0, c.indexOf('});')));
    assert.ok(calls.length >= 6);
    for (const c of calls) {
      assert.equal(/\bnote\b|reason|leaveType|typeName/.test(c), false, c);
    }
  });
  test('the attachment is refused to anyone who would see the type redacted', () => {
    assert.match(src, /if \(!st\.mayOpen \|\| st\.redact\) return error\(res, 'Leave request not found', 404\)/);
  });
  test('HR mode: over-balance is a warning with its own message', () => {
    assert.equal(msg('OVER_BALANCE').code, 'OVER_BALANCE');
    assert.ok(msg('OVER_BALANCE').message.length > 10);
  });
});

describe('employmentFlips — the On Leave sweep', () => {
  const profiles = [
    { userId: 1, status: 'Active' },
    { userId: 2, status: 'On Leave' },
    { userId: 3, status: 'On Leave' },
    { userId: 4, status: 'Suspended' },
    { userId: 5, status: 'On Leave' },
  ];
  const r = employmentFlips({
    profiles,
    coveringToday: new Set([1, 4, 5]),
    endedRecently: new Set([2]),
  });
  test('approved leave today → On Leave', () => assert.deepEqual(r.toOnLeave, [1]));
  test('leave ended → Active; a hand-set On Leave with no leave behind it stays', () => assert.deepEqual(r.toActive, [2]));
  test('Suspended is never touched', () => {
    assert.ok(!r.toOnLeave.includes(4)); assert.ok(!r.toActive.includes(4));
  });
});
