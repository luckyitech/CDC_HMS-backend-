// HR fixes, 5 Oct 2026 (session-manual issues #1–#23, owner decisions).
// Pure rules, plus the controller gates driven with a fake req/res and the
// few model reads stubbed — no database is opened here (tests/_noScopeRows
// stands in for the scope reads). The migrations' up/down were also run
// against the scratch database (see claude/… fixes-done notes).
const db = require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  PERMISSIONS: P, PRESET_EXCLUDED, HR_DELEGABLE, ALL_PERMISSIONS, PERMISSION_GROUPS,
  reconcilePermissionLists,
} = require('../constants/permissions');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const user = (role, permissions = [], denied = [], id = 1, extra = {}) =>
  ({ id, role, permissions, deniedPermissions: denied, staffType: 'non_clinical', ...extra });

/** A fake res that records what the controller answered. */
const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

// ---------------------------------------------------------------------------
// #1 Reports to
// ---------------------------------------------------------------------------
describe('#1 reports to — the pure rule', () => {
  const { normaliseReportsTo, reportsToProblem } = require('../utils/reportsTo');
  const mgr = (o = {}) => ({ id: 7, role: 'nurse', isActive: true, archived: false, ...o });

  test('blank clears; junk is refused', () => {
    assert.equal(normaliseReportsTo(''), null);
    assert.equal(normaliseReportsTo(null), null);
    assert.equal(normaliseReportsTo(undefined), null);
    assert.equal(normaliseReportsTo('7'), 7);
    assert.ok(Number.isNaN(normaliseReportsTo('abc')));
    assert.ok(Number.isNaN(normaliseReportsTo(-3)));
    assert.equal(reportsToProblem({ personId: 5, managerId: null }), null);
    assert.equal(reportsToProblem({ personId: 5, managerId: NaN }).code, 'INVALID');
  });
  test('never yourself', () => {
    assert.equal(reportsToProblem({ personId: 7, managerId: 7, manager: mgr() }).code, 'SELF');
  });
  test('only an active, unarchived member of staff — any department', () => {
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr() }), null);
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr({ role: 'admin' }) }), null);
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: null }).code, 'NOT_ACTIVE_STAFF');
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr({ role: 'patient' }) }).code, 'NOT_ACTIVE_STAFF');
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr({ isActive: false }) }).code, 'NOT_ACTIVE_STAFF');
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr({ archived: true }) }).code, 'NOT_ACTIVE_STAFF');
  });
  test('no loops: A → B → A, and a longer chain', () => {
    // 7 already reports to 5: 5 may not now report to 7.
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr(), managerOf: new Map([[7, 5]]) }).code, 'CYCLE');
    // 7 → 8 → 9 → 5
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr(), managerOf: new Map([[7, 8], [8, 9], [9, 5]]) }).code, 'CYCLE');
    // 7 → 8 → 9 (top) is fine
    assert.equal(reportsToProblem({ personId: 5, managerId: 7, manager: mgr(), managerOf: new Map([[7, 8], [8, 9]]) }), null);
    // a new person (no id yet) cannot close a loop
    assert.equal(reportsToProblem({ personId: null, managerId: 7, manager: mgr(), managerOf: new Map([[7, 5]]) }), null);
  });
  test('resolveReportsTo reads the manager and the chain', async () => {
    const { resolveReportsTo, ReportsToError } = require('../services/reportsTo');
    const origFind = db.User.findByPk;
    const origAll = db.StaffProfile.findAll;
    db.User.findByPk = async (id) => (id === 7 ? { id: 7, role: 'nurse', isActive: true, StaffProfile: { deletedAt: null } } : null);
    db.StaffProfile.findAll = async () => [{ UserId: 7, reportsToId: 5 }];
    try {
      assert.equal(await resolveReportsTo(9, '7'), 7);
      assert.equal(await resolveReportsTo(9, ''), null);
      await assert.rejects(resolveReportsTo(5, 7), (e) => e instanceof ReportsToError && e.code === 'CYCLE');
      await assert.rejects(resolveReportsTo(9, 8), (e) => e.code === 'NOT_ACTIVE_STAFF');
      assert.equal(await resolveReportsTo(null, 7), 7);
    } finally {
      db.User.findByPk = origFind;
      db.StaffProfile.findAll = origAll;
    }
  });
  test('naming yourself as line manager needs appraisal-running (review S6)', async () => {
    const { namingYourselfProblem } = require('../utils/reportsTo');
    assert.equal(namingYourselfProblem({ callerId: 2, managerId: 2, callerMayNameSelf: false }).code, 'NAMING_YOURSELF');
    assert.equal(namingYourselfProblem({ callerId: 2, managerId: 2, callerMayNameSelf: true }), null);
    assert.equal(namingYourselfProblem({ callerId: 2, managerId: 7, callerMayNameSelf: false }), null);
    assert.equal(namingYourselfProblem({ callerId: 2, managerId: null, callerMayNameSelf: false }), null);
    const { resolveReportsTo } = require('../services/reportsTo');
    const origFind = db.User.findByPk;
    db.User.findByPk = async (id) => ({ id, role: 'staff', isActive: true, StaffProfile: { deletedAt: null } });
    try {
      await assert.rejects(resolveReportsTo(9, 2, user('staff', [P.STAFF_EDIT], [], 2)), (e) => e.code === 'NAMING_YOURSELF');
      assert.equal(await resolveReportsTo(9, 2, user('staff', [P.STAFF_EDIT, P.HR_APPRAISALS_RUN], [], 2)), 2);
      assert.equal(await resolveReportsTo(9, 1, user('admin', [], [], 1)), 1);
      assert.equal(await resolveReportsTo(9, 7, user('staff', [P.STAFF_EDIT], [], 2)), 7);
    } finally { db.User.findByPk = origFind; }
  });
  test('both writers go through it; the route validates the id', () => {
    assert.match(src('controllers/staffController.js'), /resolveReportsTo\(user\.id, updates\.reportsToId, req\.user\)/);
    assert.match(src('controllers/userController.js'), /resolveReportsTo\(null, req\.body\.reportsToId, req\.user\)/);
    assert.match(src('routes/staff.js'), /body\('reportsToId'\)\.optional\(\{ nullable: true, checkFalsy: true \}\)\.isInt\(\{ min: 1 \}\)/);
  });
});

// ---------------------------------------------------------------------------
// #2 Confidential categories filed Admin only, by category
// ---------------------------------------------------------------------------
describe('#2 upload visibility by category', () => {
  const { documentVisibility, ADMIN_ONLY_CATEGORIES } = require('../utils/hrAccess');
  test('without hr.confidential: contract, appraisal, disciplinary go to the drawer; the rest stay visible', () => {
    assert.deepEqual(ADMIN_ONLY_CATEGORIES, ['Employment Contract', 'Appraisal', 'Disciplinary']);
    for (const c of ADMIN_ONLY_CATEGORIES) assert.equal(documentVisibility({ confidential: false, category: c }), 'Admin only', c);
    for (const c of ['CV', 'National ID', 'Practising Licence', 'Other']) assert.equal(documentVisibility({ confidential: false, category: c }), 'Staff', c);
  });
  test('a non-holder cannot choose: a requested visibility is ignored', () => {
    assert.equal(documentVisibility({ confidential: false, category: 'Disciplinary', requested: 'Staff' }), 'Admin only');
    assert.equal(documentVisibility({ confidential: false, category: 'CV', requested: 'Admin only' }), 'Staff');
  });
  test('your own upload to your own file stays visible to you (any category)', () => {
    for (const c of ['Employment Contract', 'Appraisal', 'Disciplinary', 'CV']) {
      assert.equal(documentVisibility({ confidential: false, category: c, isSelf: true }), 'Staff', c);
    }
    // a holder filing on their own file still chooses
    assert.equal(documentVisibility({ confidential: true, category: 'CV', isSelf: true }), 'Admin only');
  });
  test('a holder chooses freely; default Admin only', () => {
    assert.equal(documentVisibility({ confidential: true, category: 'Employment Contract', requested: 'Staff' }), 'Staff');
    assert.equal(documentVisibility({ confidential: true, category: 'CV' }), 'Admin only');
  });
  test('the upload and a re-categorisation both use the rule', () => {
    const s = src('controllers/staffDocumentController.js');
    assert.match(s, /confidential, category: category \|\| 'Other', requested: req\.body\.visibility,\s+isSelf: req\.staffUser\.id === req\.user\.id,/);
    assert.match(s, /documentVisibility\(\{ confidential: false, category, isSelf: req\.staffUser\.id === req\.user\.id \}\) === 'Admin only'/);
  });
});

// ---------------------------------------------------------------------------
// #3 Cancel requested: away on the board; the reminder
// ---------------------------------------------------------------------------
describe('#3 cancel requested', () => {
  const { cancelRemindersDue, TAKEN_STATUSES, STATUS } = require('../utils/leaveWorkflow');
  test('still counts as away on the Today board and in the month calendar', () => {
    assert.ok(TAKEN_STATUSES.includes(STATUS.CANCEL_REQUESTED));
    assert.match(src('controllers/hrAttendanceController.js'), /status: \{ \[Op\.in\]: TAKEN_STATUSES \}, startDate: \{ \[Op\.lte\]: clinicDate \}/);
    assert.match(src('services/hrAttendanceService.js'), /status: \{ \[Op\.in\]: TAKEN_STATUSES \}, startDate: \{ \[Op\.lte\]: to \}/);
  });
  test('reminder due only for an undecided cancel request starting tomorrow, once', () => {
    const leaves = [
      { id: 1, status: 'CancelRequested', startDate: '2026-10-06' },
      { id: 2, status: 'Approved', startDate: '2026-10-06' },
      { id: 3, status: 'CancelRequested', startDate: '2026-10-07' },
      { id: 4, status: 'CancelRequested', startDate: '2026-10-06' },
    ];
    assert.deepEqual(cancelRemindersDue(leaves, '2026-10-06', new Set([4])).map((l) => l.id), [1]);
  });
  test('rides the existing five-minute HR sweep, de-duped on the leave timeline, to the approvers', () => {
    const s = src('services/hrAttendanceSweep.js');
    assert.match(s, /runCancelRequestReminders\(\)\.catch/);
    assert.match(s, /type: 'notified'/);
    assert.match(s, /kind: KIND\.APPROVER/);
    assert.match(s, /hrNotify\.notify\('leave_cancelled'/);
    // recorded BEFORE the send, so a failed send can't repeat every 5 minutes
    assert.ok(s.indexOf('await LeaveEvent.create') < s.indexOf("hrNotify.notify('leave_cancelled'"));
  });

  // Drives runCancelRequestReminders with the model reads stubbed.
  const runWith = async ({ now, approvers, managers }) => {
    const sweep = require('../services/hrAttendanceSweep');
    const hrScope = require('../services/hrScope');
    const hrNotify = require('../services/hrNotify');
    const saved = {
      sl: db.StaffLeave.findAll, le: db.LeaveEvent.findAll, lp: db.LeaveParticipant.findAll,
      lc: db.LeaveEvent.create, hf: hrScope.holdersFor, nf: hrNotify.notify,
    };
    const created = []; const sent = []; const askedScope = [];
    db.StaffLeave.findAll = async () => [{
      id: 9, UserId: 50, status: 'CancelRequested', startDate: '2026-10-26', endDate: '2026-10-28',
      User: { firstName: 'Peter', lastName: 'K' }, get() { return { id: 9, UserId: 50, status: 'CancelRequested', startDate: '2026-10-26' }; },
    }];
    db.LeaveEvent.findAll = async () => [];
    db.LeaveParticipant.findAll = async () => approvers.map((id) => ({ UserId: id }));
    db.LeaveEvent.create = async (row) => { created.push(row); return row; };
    hrScope.holdersFor = async (cap, uid) => { askedScope.push([cap, uid]); return managers; };
    hrNotify.notify = async (event, o) => { sent.push([event, o.recipients]); return {}; };
    try {
      const n = await sweep.runCancelRequestReminders(now);
      return { n, created, sent, askedScope };
    } finally {
      db.StaffLeave.findAll = saved.sl; db.LeaveEvent.findAll = saved.le; db.LeaveParticipant.findAll = saved.lp;
      db.LeaveEvent.create = saved.lc; hrScope.holdersFor = saved.hf; hrNotify.notify = saved.nf;
    }
  };
  test('waits until 06:00 Nairobi (review S4)', async () => {
    const early = await runWith({ now: new Date('2026-10-25T00:30:00Z'), approvers: [8], managers: [] });   // 03:30 EAT
    assert.equal(early.n, 0);
    assert.equal(early.created.length, 0);
    const later = await runWith({ now: new Date('2026-10-25T05:00:00Z'), approvers: [8], managers: [] });  // 08:00 EAT
    assert.equal(later.n, 1);
    assert.deepEqual(later.sent, [['leave_cancelled', [8]]]);
    assert.equal(later.askedScope.length, 0);
    const { nairobiHour } = require('../utils/clinicTime');
    assert.equal(nairobiHour(new Date('2026-10-25T03:00:00Z')), 6);
    assert.match(src('services/expiryReminders.js'), /const \{ clinicToday, nairobiHour \} = require\('\.\.\/utils\/clinicTime'\)/);
  });
  test('no approvers: leave.manage holders in scope (not the applicant); nobody: nothing written (review S5)', async () => {
    const r = await runWith({ now: new Date('2026-10-25T05:00:00Z'), approvers: [], managers: [4, 50] });
    assert.deepEqual(r.askedScope, [['leave.manage', 50]]);
    assert.deepEqual(r.sent, [['leave_cancelled', [4]]]);
    assert.match(r.created[0].note, /no approvers/);
    const none = await runWith({ now: new Date('2026-10-25T05:00:00Z'), approvers: [], managers: [50] });
    assert.equal(none.n, 0);
    assert.equal(none.created.length, 0);
    assert.equal(none.sent.length, 0);
  });
});

// ---------------------------------------------------------------------------
// #4 CPD: never your own
// ---------------------------------------------------------------------------
describe('#4 CPD self-verification', () => {
  const cpd = require('../controllers/cpdController');
  test('the server refuses verifying your own entry (403 OWN_ACTIVITY), before anything is written', async () => {
    const orig = db.CpdActivity.findByPk;
    let updated = false;
    db.CpdActivity.findByPk = async () => ({ id: 3, UserId: 21, status: 'pending', points: 2, update: async () => { updated = true; } });
    try {
      const res = fakeRes();
      await cpd.verify({ params: { id: '3' }, body: { decision: 'verify' }, user: user('staff', [P.CPD_VERIFY], [], 21) }, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'OWN_ACTIVITY');
      assert.equal(updated, false);
    } finally { db.CpdActivity.findByPk = orig; }
  });
  test('the queue marks your own rows and the badge leaves them out', () => {
    const s = src('controllers/cpdController.js');
    assert.match(s, /mine: Number\(r\.UserId\) === Number\(req\.user\.id\)/);
    assert.match(s, /scoped === null \? \{ \[Op\.ne\]: req\.user\.id \}/);
  });
});

// ---------------------------------------------------------------------------
// #5 Roster wins over a hand-set dated override
// ---------------------------------------------------------------------------
describe('#5 roster vs working-hours overrides', () => {
  const { sameDatedHours, changedOverrides, rosterClashes } = require('../utils/roster');
  const ex = new Map([
    ['2026-10-06', { date: '2026-10-06', isOff: false, startTime: '22:00', endTime: '07:00', graceMinutes: null }],
    ['2026-10-07', { date: '2026-10-07', isOff: true, startTime: null, endTime: null, graceMinutes: null }],
  ]);
  test('an override sent back unchanged is not a change (the editor resends them all — incl. overnight roster rows)', () => {
    assert.ok(sameDatedHours({ isOff: false, startTime: '22:00:00', endTime: '07:00' }, ex.get('2026-10-06')));
    const changes = changedOverrides([
      { date: '2026-10-06', isOff: false, startTime: '22:00', endTime: '07:00' },
      { date: '2026-10-07', isOff: true },
      { date: '2026-10-08', isOff: true },
      { date: '2026-10-09', remove: true },
    ], ex);
    assert.deepEqual(changes.map((o) => o.date), ['2026-10-08']);
  });
  test('a different time, a grace, or a removal on an existing day IS a change', () => {
    assert.equal(changedOverrides([{ date: '2026-10-07', isOff: false, startTime: '08:00', endTime: '12:00' }], ex).length, 1);
    assert.equal(changedOverrides([{ date: '2026-10-07', isOff: true, graceMinutes: 10 }], ex).length, 1);
    assert.equal(changedOverrides([{ date: '2026-10-07', remove: true }], ex).length, 1);
  });
  test('clashes are the changed days that have a published roster cell', () => {
    const c = rosterClashes([{ date: '2026-10-06' }, { date: '2026-10-08' }], [{ id: 9, date: '2026-10-06' }]);
    assert.deepEqual(c.map((x) => [x.date, x.cell.id]), [['2026-10-06', 9]]);
  });
  test('PUT work-hours answers 409 ROSTERED until confirmed with replaceRoster', async () => {
    const ctrl = require('../controllers/hrWorkHoursController');
    const saved = {
      uf: db.User.findByPk, wa: db.StaffWorkHours.findAll, ra: db.RosterShift.findAll, tx: db.sequelize.transaction,
    };
    let opened = false;
    db.User.findByPk = async () => ({ id: 30, role: 'nurse', firstName: 'Amina', lastName: 'Otieno' });
    db.StaffWorkHours.findAll = async () => [];
    db.RosterShift.findAll = async () => [{ id: 4, date: '2026-10-06', isOff: false, startTime: '07:00:00', endTime: '15:00:00', shiftType: { name: 'Early' } }];
    db.sequelize.transaction = async () => { opened = true; throw new Error('stop here'); };
    try {
      const res = fakeRes();
      await ctrl.update({ params: { userId: '30' }, body: { overrides: [{ date: '2026-10-06', isOff: true }] }, user: user('staff', [P.HR_WORKHOURS], [], 2) }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'ROSTERED');
      assert.deepEqual(res.body.dates, [{ date: '2026-10-06', shift: 'Early 07:00–15:00' }]);
      assert.match(res.body.message, /Amina Otieno is rostered for Early 07:00–15:00 on Tue 6 Oct/);
      assert.equal(opened, false);
      // confirmed: goes on to write (the stub stops it at the transaction)
      const res2 = fakeRes();
      await ctrl.update({ params: { userId: '30' }, body: { overrides: [{ date: '2026-10-06', isOff: true }], replaceRoster: true }, user: user('staff', [P.HR_WORKHOURS], [], 2) }, res2);
      assert.equal(opened, true);
    } finally {
      db.User.findByPk = saved.uf; db.StaffWorkHours.findAll = saved.wa; db.RosterShift.findAll = saved.ra; db.sequelize.transaction = saved.tx;
    }
  });
  test('publishing reports the hand-set overrides it replaced, and logs them', () => {
    const s = src('services/roster.js');
    assert.match(s, /replacedOverrides: nameReplaced\(replaced, people\)/);
    assert.match(s, /to: 'replaced by the roster'/);
    assert.match(s, /return replaced;/);
  });
});

// ---------------------------------------------------------------------------
// #6 / #7 / #8 / #9 Attendance
// ---------------------------------------------------------------------------
describe('#6 the "first tap checks in immediately" setting is gone', () => {
  const { FIELDS, DEFAULTS } = require('../utils/hrConfig');
  test('not a setting, not a default, not validated', () => {
    assert.equal(FIELDS.autoCheckin, undefined);
    assert.equal((DEFAULTS || {}).autoCheckin, undefined);
    assert.doesNotMatch(src('routes/hr.js'), /autoCheckin/);
  });
});

describe('#7 phone location off', () => {
  test('the tap page can read the mode, behind the same gate as the tap', () => {
    assert.match(src('routes/hr.js'), /router\.get\('\/attendance\/checkin-config', authenticate, authorize\(\.\.\.CHECKIN\), hrAttendance\.checkinConfig\)/);
    // declared before /attendance/:id, which would otherwise swallow it
    const r = src('routes/hr.js');
    assert.ok(r.indexOf("'/attendance/checkin-config'") < r.indexOf("'/attendance/:id'"));
  });
});

describe('#8 check-out stars use the person\'s own grace', () => {
  const svc = require('../services/hrAttendanceService');
  test('the grace stored at check-in wins (JSON column as object or text)', async () => {
    const cfg = { graceMinutes: 0, hoursDefault: {} };
    assert.equal(await svc.graceOf({ diagnostics: { grace: 15 } }, cfg), 15);
    assert.equal(await svc.graceOf({ diagnostics: JSON.stringify({ grace: 0 }) }, cfg), 0);
  });
  test('the tap never passes the clinic grace for a check-out', () => {
    // 17 Oct 2026: the tap is a punch; the day is rebuilt in services/punchService.
    const s = src('controllers/hrAttendanceController.js');
    assert.doesNotMatch(s, /graceMinutes: cfg\.graceMinutes, kind: 'out'/);
    assert.match(s, /graceMinutes: await svc\.graceOf\(session, cfg\), kind: 'out'/);
    assert.match(s, /const grace = await svc\.graceOf\(session, cfg\);/);
    const p = src('services/punchService.js');
    assert.doesNotMatch(p, /graceMinutes: cfg\.graceMinutes/);
    assert.match(p, /grace: await svc\.graceOf\(session, cfg\)/);
    assert.match(p, /grace: expected\.grace/);
  });
});

describe('#9 who the Today board expects', () => {
  const { expectedAtWork } = require('../utils/attendanceRules');
  test('not administrator accounts; only holders of Check in and out', () => {
    assert.equal(expectedAtWork(user('admin')), false);
    assert.equal(expectedAtWork(user('nurse', [], [], 1, { staffType: 'clinical' })), true);
    assert.equal(expectedAtWork(user('staff')), true);
    assert.equal(expectedAtWork(user('staff', [], [P.HR_CHECKIN])), false);
    assert.equal(expectedAtWork(user('doctor', [P.ADMIN_ACCESS], [], 1, { staffType: 'clinical' })), true);
  });
  test('the gate is exactly the tap route\'s CHECKIN list', () => {
    const { CHECKIN_GATE } = require('../utils/attendanceRules');
    const m = /const CHECKIN = \[([^\]]+)\]/.exec(src('routes/hr.js'));
    const route = m[1].split(',').map((x) => x.trim().replace(/'/g, ''));
    assert.deepEqual([...CHECKIN_GATE].sort(), route.sort());
  });
  test('the board filters on it (someone who tapped still shows)', () => {
    const s = src('controllers/hrAttendanceController.js');
    assert.match(s, /users\.filter\(\(u\) => expectedAtWork\(u\) \|\| \(byUser\.get\(u\.id\) \|\| \[\]\)\.length\)/);
    assert.match(src('services/hrAttendanceService.js'), /'permissions', 'deniedPermissions', 'staffType'/);
  });
});

// ---------------------------------------------------------------------------
// #11 Confidential documents: expiry reminders and the report
// ---------------------------------------------------------------------------
describe('#11 confidential document expiry', () => {
  test('reminders go to hr.confidential holders only (an explicit grant), never the person; sick notes never', () => {
    const s = src('services/expiryReminders.js');
    assert.match(s, /visibility: 'Admin only'/);
    assert.match(s, /holdersFor\(PERMISSIONS\.HR_CONFIDENTIAL, userId, \{ holds: canViewConfidential \}\)/);
    assert.match(s, /ownerId: null/);
    assert.match(s, /if \(isHealthDocument\(d\)\) continue;/);
    assert.match(s, /if \(ownerId\) \{/);
  });
  test('the expiry report lists them only for a viewer who may open that person\'s drawer', () => {
    const s = src('services/hrReports.js');
    assert.match(s, /expiryReport\(employed, today, w, names, user\)/);
    assert.match(s, /viewer && canViewConfidential\(viewer\)/);
    assert.match(s, /hrScope\.canActOn\(viewer, PERMISSIONS\.HR_CONFIDENTIAL, id\)/);
  });
});

// ---------------------------------------------------------------------------
// #14 Labels, not keys
// ---------------------------------------------------------------------------
describe('#14 leave-type labels in validation messages', () => {
  const rules = require('../utils/leavePolicyRules');
  test('validatePolicy and publishProblems name the type by its label', () => {
    const r = rules.validatePolicy({ weekWeights: { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0.5 }, types: { Study: { grant: 'up_front', days: 'x' } } },
      { activeKeys: ['Study'], names: { Study: 'Study / CPD' } });
    assert.ok(r.errors.some((e) => e.startsWith('Study / CPD:')), r.errors.join(' | '));
    const p = rules.publishProblems({ types: { Study: { enabled: true, grant: 'up_front', days: null } }, visibleTypes: ['Study'] }, ['Study'], { Study: 'Study / CPD' });
    assert.ok(p.includes('Study / CPD has no number of days.'));
  });
  test('the controllers pass the names', () => {
    const s = src('controllers/leaveSettingsController.js');
    assert.match(s, /validatePolicy\(req\.body \|\| \{\}, \{ activeKeys, names \}\)/);
    assert.match(s, /`\$\{typeNames\[b\.leaveType\]\}: \$\{f === 'entitled'/);
  });
});

// ---------------------------------------------------------------------------
// #16 Login email
// ---------------------------------------------------------------------------
describe('#16 who may change a login email', () => {
  const { loginEmailRefusal } = require('../utils/hrGrant');
  const editor = (extra = [], id = 2) => user('staff', [P.USERS_WRITE, ...extra], [], id);
  const plain = user('nurse', [], [], 30);
  test('only a Manage Users editor — staff.edit is not enough', () => {
    assert.equal(loginEmailRefusal({ caller: user('staff', [P.STAFF_EDIT, P.STAFF_VIEW]), target: plain }).extra.code, 'LOGIN_EMAIL_NOT_ALLOWED');
    assert.equal(loginEmailRefusal({ caller: editor(), target: plain }), null);
    assert.equal(loginEmailRefusal({ caller: user('doctor', [P.ADMIN_ACCESS]), target: plain }), null);
    // a withdrawal of Manage Users wins
    assert.equal(loginEmailRefusal({ caller: user('staff', [P.USERS_WRITE], [P.USERS_WRITE]), target: plain }).code, 403);
  });
  test('never an administrator\'s account unless a permissions administrator or the true admin', () => {
    for (const target of [
      user('admin', [], [], 40), user('doctor', [P.ADMIN_ACCESS], [], 40),
      user('staff', [P.PERMISSIONS_GRANT], [], 40), user('staff', [P.HR_GRANT], [], 40),
    ]) {
      // a plain Manage Users editor: refused (protected, or holds more)
      assert.ok(['LOGIN_EMAIL_PROTECTED', 'LOGIN_EMAIL_HOLDS_MORE'].includes(loginEmailRefusal({ caller: editor(), target }).extra.code), JSON.stringify(target.permissions));
      assert.equal(loginEmailRefusal({ caller: user('admin', [], [], 1), target }), null);
      // a permissions administrator who holds everything the target was granted
      if (target.role !== 'admin') {
        assert.equal(loginEmailRefusal({ caller: editor([P.PERMISSIONS_GRANT, ...target.permissions]), target }), null);
      }
    }
  });
  test('an HR grantor with Manage Users: never an admin, never yourself, never a peer HR grantor (review S2)', () => {
    const hr = editor([P.HR_GRANT], 2);
    assert.equal(loginEmailRefusal({ caller: hr, target: user('staff', [P.HR_GRANT], [], 40) }).extra.code, 'LOGIN_EMAIL_PROTECTED');
    assert.ok(loginEmailRefusal({ caller: hr, target: user('doctor', [P.ADMIN_ACCESS], [], 40) }));
    assert.ok(loginEmailRefusal({ caller: hr, target: { ...hr } }));
    // a protected account holding only what the HR grantor holds: allowed
    assert.equal(loginEmailRefusal({ caller: hr, target: user('staff', [P.USERS_WRITE], [], 40) }), null);
  });
  test('confidential, appraisal-reading and Manage Users holders are protected too (review S2)', () => {
    const officer = editor([P.HR_CONFIDENTIAL, P.HR_APPRAISALS], 2);
    for (const cap of [P.HR_CONFIDENTIAL, P.HR_APPRAISALS, P.USERS_WRITE]) {
      assert.equal(loginEmailRefusal({ caller: officer, target: user('staff', [cap], [], 40) }).extra.code, 'LOGIN_EMAIL_PROTECTED', cap);
      assert.equal(loginEmailRefusal({ caller: editor([P.PERMISSIONS_GRANT, cap]), target: user('staff', [cap], [], 40) }), null, cap);
    }
  });
  test('never someone holding a control the caller lacks (review S2)', () => {
    // a permissions administrator without the confidential drawer can't reset a holder
    const r = loginEmailRefusal({ caller: editor([P.PERMISSIONS_GRANT]), target: user('staff', [P.HR_CONFIDENTIAL], [], 40) });
    assert.equal(r.extra.code, 'LOGIN_EMAIL_HOLDS_MORE');
    assert.deepEqual(r.extra.capabilities, [P.HR_CONFIDENTIAL]);
    // a plain Manage Users editor can't reset someone granted stock access they lack
    assert.equal(loginEmailRefusal({ caller: editor(), target: user('staff', [P.STOCK_ANALYTICS], [], 40) }).extra.code, 'LOGIN_EMAIL_HOLDS_MORE');
    // role defaults are not grants: a doctor's clinical access does not block it
    assert.equal(loginEmailRefusal({ caller: editor(), target: user('doctor', [], [], 40, { staffType: 'clinical' }) }), null);
    // only the true admin may change the true admin's
    assert.equal(loginEmailRefusal({ caller: editor([P.PERMISSIONS_GRANT]), target: user('admin', [], [], 40) }).extra.code, 'LOGIN_EMAIL_PROTECTED');
  });
  test('an empty login email is a 400, not a database error (review nit 2)', async () => {
    const ctrl = require('../controllers/staffController');
    const res = fakeRes();
    await ctrl.update({
      staffProfile: { deletedAt: null }, staffUser: { id: 30, role: 'nurse', email: 'old@x.example', permissions: [], deniedPermissions: [] },
      body: { email: null }, user: user('admin', [], [], 1),
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'EMAIL_REQUIRED');
    assert.match(src('controllers/userController.js'), /'A login email is required', 400, \{ code: 'EMAIL_REQUIRED' \}/);
  });
  test('the "Change" control also needs the staff-file edit gate and scope (review nit 1)', () => {
    assert.match(src('controllers/staffController.js'), /canChangeLoginEmail\(caller, staffUser\)\s+&& passesAdminGate\(caller, PERMISSIONS\.STAFF_EDIT\)\s+&& await hrScope\.canActOn\(caller, PERMISSIONS\.STAFF_EDIT, staffUser\.id\)/);
  });
  test('PUT /api/staff refuses a staff.edit holder before anything is read or written', async () => {
    const ctrl = require('../controllers/staffController');
    const res = fakeRes();
    await ctrl.update({
      staffProfile: { deletedAt: null }, staffUser: { id: 30, role: 'nurse', email: 'old@x.example', permissions: [], deniedPermissions: [] },
      body: { email: 'new@x.example' }, user: user('staff', [P.STAFF_EDIT], [], 2),
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'LOGIN_EMAIL_NOT_ALLOWED');
  });
  test('both endpoints use the rule, log it, and warn the OLD address', () => {
    const s = src('controllers/staffController.js');
    const u = src('controllers/userController.js');
    assert.match(s, /loginEmailRefusal\(\{ caller: req\.user, target: user \}\)/);
    assert.match(u, /loginEmailRefusal\(\{ caller: req\.user, target: user \}\)/);
    assert.match(s, /notifyLoginEmailChanged\(userBefore\.email, user, userUpdates\.email\)/);
    assert.match(u, /notifyLoginEmailChanged\(userBefore\.email, user, userUpdates\.email\)/);
    assert.match(s, /sendHrNoticeEmail\(\{\s*to: oldEmail/);
    assert.match(s, /\.catch\(\(e\) => console\.error\('StaffProfile\.notifyLoginEmailChanged error:', e\)\)/);
    assert.match(s, /loginEmailEditable: canChangeLoginEmail\(caller, staffUser\)/);
  });
});

// ---------------------------------------------------------------------------
// #18 Labels
// ---------------------------------------------------------------------------
describe('#1/#16 every single-file response carries the same extras', () => {
  test('getOne, update, status, restore and permissions all return fullFile (reportsTo, loginEmailEditable, scopes)', () => {
    const s = src('controllers/staffController.js');
    assert.equal((s.match(/return success\(res, await fullFile\(/g) || []).length, 5);
    assert.doesNotMatch(s, /return success\(res, formatStaff\(profile, user\)\)/);
    assert.match(src('controllers/hrProfileController.js'), /s\.reportsTo = await reportsToSummary\(profile\.reportsToId\)/);
  });
});

describe('#18 users.view / users.write labels', () => {
  test('say Manage Users / login accounts, not staff files', () => {
    const area = PERMISSION_GROUPS.flatMap((g) => g.areas).find((a) => a.key === 'users');
    assert.equal(area.name, 'Users (login accounts)');
    assert.match(area.accessLabel, /Manage Users/);
    assert.doesNotMatch(area.accessLabel, /staff files/);
    assert.doesNotMatch(area.writeLabel, /staff files/);
  });
});

// ---------------------------------------------------------------------------
// #21 Appraisal NO_REVIEWER
// ---------------------------------------------------------------------------
describe('#21 NO_REVIEWER says nothing was saved', () => {
  test('the message matches the rollback', () => {
    const s = src('services/appraisals.js');
    assert.match(s, /HR has not chosen your reviewer yet, so nothing was saved/);
    assert.doesNotMatch(s, /your answers are saved/);
  });
});

// ---------------------------------------------------------------------------
// #22 Apply a preset to an existing account
// ---------------------------------------------------------------------------
describe('#22 apply preset', () => {
  const { presetApplyRefusal } = require('../utils/hrGrant');
  const hrGrantor = user('staff', [P.HR_GRANT, P.STAFF_VIEW, P.HR_VIEW, P.LEAVE_APPROVE, P.LEAVE_VIEW], [], 2);
  test('an HR grantor: every control must be an HR control they hold', () => {
    assert.equal(presetApplyRefusal({ caller: hrGrantor, granted: [P.STAFF_VIEW, P.HR_VIEW] }), null);
    assert.equal(presetApplyRefusal({ caller: hrGrantor, granted: [P.STAFF_VIEW, P.STOCK_ANALYTICS] }).extra.code, 'PRESET_NOT_DELEGABLE');
    assert.equal(presetApplyRefusal({ caller: hrGrantor, granted: [P.STAFF_VIEW], denied: ['glp1.write'] }).extra.code, 'PRESET_NOT_DELEGABLE');
    assert.equal(presetApplyRefusal({ caller: hrGrantor, granted: [P.STAFF_EDIT] }).extra.code, 'PRESET_NOT_HELD');
    // a withdrawal of an HR control they don't hold is fine (taking away)
    assert.equal(presetApplyRefusal({ caller: hrGrantor, granted: [], denied: [P.LEAVE_SICK] }), null);
  });
  const presetRow = (o = {}) => ({
    id: 5, name: 'Staff nurse', status: 'active', baseRole: 'nurse', staffType: 'clinical',
    permissions: ['glp1.write'], deniedPermissions: [], scopes: {}, ...o,
  });
  const callUpdate = async (caller, body, preset) => {
    const orig = db.PermissionPreset.findByPk;
    db.PermissionPreset.findByPk = async () => preset;
    try {
      const res = fakeRes();
      const ctrl = require('../controllers/staffController');
      await ctrl.updatePermissions({
        staffUser: { id: 30, role: 'nurse', staffType: 'clinical', permissions: [], deniedPermissions: [] },
        staffProfile: {}, body, user: caller,
      }, res);
      return res;
    } finally { db.PermissionPreset.findByPk = orig; }
  };
  test('PATCH …/permissions { presetId }: refused for an HR grantor when the preset has non-HR controls', async () => {
    const res = await callUpdate(hrGrantor, { presetId: 5 }, presetRow());
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'PRESET_NOT_DELEGABLE');
  });
  test('never on your own account (review S3)', async () => {
    const orig = db.PermissionPreset.findByPk;
    let looked = false;
    db.PermissionPreset.findByPk = async () => { looked = true; return presetRow(); };
    try {
      const res = fakeRes();
      await require('../controllers/staffController').updatePermissions({
        staffUser: { id: 30, role: 'nurse', staffType: 'clinical', permissions: [P.PERMISSIONS_GRANT], deniedPermissions: [] },
        staffProfile: {}, body: { presetId: 5 }, user: user('nurse', [P.PERMISSIONS_GRANT], [], 30),
      }, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'OWN_ACCOUNT');
      assert.equal(looked, false);
    } finally { db.PermissionPreset.findByPk = orig; }
  });
  test('an unknown/archived preset, or one for another role, is refused', async () => {
    assert.equal((await callUpdate(user('admin'), { presetId: 5 }, null)).statusCode, 400);
    assert.equal((await callUpdate(user('admin'), { presetId: 5 }, presetRow({ status: 'archived' }))).statusCode, 400);
    assert.match((await callUpdate(user('admin'), { presetId: 5 }, presetRow({ baseRole: 'staff' }))).body.message, /is for a staff account, not a nurse/);
  });
  test('an HR grantor can read the preset list (without users.view / staff.onboard)', () => {
    const r = src('routes/permissionPresets.js');
    assert.match(r, /passesGate\(req\.user, READERS\) \|\| canEditPermissions\(req\.user\)/);
    assert.match(r, /router\.get\('\/',\s+authenticate, presetReader, ctrl\.list\)/);
  });
  test('it replaces lists, staff type and limits; counts the use; logs the preset name', () => {
    const s = src('controllers/staffController.js');
    assert.match(s, /scopes: Object\.fromEntries\(SCOPABLE\.filter\(\(c\) => granted\.includes\(c\)\)\.map\(\(c\) => \[c, limits\[c\] \|\| \{ kind: 'all' \}\]\)\)/);
    assert.match(s, /PermissionPreset\.increment\('appliedCount'/);
    assert.match(s, /appliedPreset: \{ from: null, to: preset\.name \}/);
    assert.match(src('routes/staff.js'), /body\('permissions'\)\.if\(body\('presetId'\)\.not\(\)\.exists\(\)\)\.isArray\(\)/);
  });
});

// ---------------------------------------------------------------------------
// #19 / #23 migrations
// ---------------------------------------------------------------------------
describe('#23 migration 20260928000016 — preset limits backfill', () => {
  const rel = 'migrations/20260928000016-hr-starter-preset-scopes-backfill.js';
  const mig = require(`../${rel}`);
  const s = src(rel);
  test('guarded both ways; uses …011\'s limits; only untouched, empty presets; marker-scoped down', () => {
    assert.match(s, /showAllTables/);
    assert.match(s, /describeTable/);
    assert.match(s, /toLowerCase\(\) === name\.toLowerCase\(\)/);
    assert.match(s, /require\('\.\/20260928000011-hr-departments-positions-scopes'\)/);
    assert.match(s, /createdById IS NULL AND updatedById IS NULL AND appliedCount = 0/);
    assert.equal(typeof mig.up, 'function');
    assert.equal(typeof mig.down, 'function');
    const down = s.slice(s.indexOf('async down'));
    assert.match(down, /readMarker/);
  });
  test('"empty" means NULL, JSON null or {}; compare ignores key order', () => {
    assert.ok(mig._isEmpty(null));
    assert.ok(mig._isEmpty('null'));
    assert.ok(mig._isEmpty('{}'));
    assert.ok(mig._isEmpty({}));
    assert.ok(!mig._isEmpty({ 'staff.view': { kind: 'own' } }));
    assert.ok(mig._sameJson({ a: 1, b: { kind: 'own' } }, { b: { kind: 'own' }, a: 1 }));
  });
  test('…011 exports exactly the limits it writes', () => {
    const { _starterScopes } = require('../migrations/20260928000011-hr-departments-positions-scopes');
    assert.deepEqual(Object.keys(_starterScopes), ['Nurse in charge', 'Line manager']);
  });
});

describe('#19 migration 20260928000017 — newer controls on the starter presets', () => {
  const rel = 'migrations/20260928000017-hr-starter-presets-newer-controls.js';
  const mig = require(`../${rel}`);
  const { PRESETS } = require('../migrations/20260928000010-hr-starter-permission-presets');
  const row = (name, o = {}) => {
    const p = PRESETS.find((x) => x.name === name);
    return { name, permissions: JSON.stringify(p.permissions), deniedPermissions: JSON.stringify(p.deniedPermissions), scopes: null, description: p.description, ...o };
  };
  test('the agreed content, all real HR controls, never an excluded one, in stored form', () => {
    assert.deepEqual(mig.ADDITIONS['HR manager'].permissions, ['hr.lists', 'hr.reports', 'hr.onboarding', 'hr.roster', 'hr.appraisals.run']);
    assert.deepEqual(mig.ADDITIONS['HR officer'].permissions, ['leave.approve', 'hr.reports', 'hr.onboarding', 'hr.roster']);
    assert.deepEqual(mig.ADDITIONS['Nurse in charge'].scopes, { 'hr.roster': { kind: 'own' }, 'hr.appraisals.run': { kind: 'own' } });
    assert.deepEqual(mig.ADDITIONS['Line manager'].scopes, { 'hr.appraisals.run': { kind: 'own' } });
    for (const p of PRESETS) {
      const after = [...p.permissions, ...mig.ADDITIONS[p.name].permissions];
      for (const cap of after) {
        assert.ok(ALL_PERMISSIONS.includes(cap), cap);
        assert.ok(HR_DELEGABLE.includes(cap), cap);
        assert.ok(!PRESET_EXCLUDED.includes(cap), cap);
      }
      const r = reconcilePermissionLists(after, p.deniedPermissions);
      assert.deepEqual([...r.granted].sort(), [...after].sort(), p.name);
    }
  });
  test('up changes a preset only while its grants equal what …010 shipped', () => {
    const v = mig._planUp(row('HR officer'));
    assert.ok(v.permissions.includes('leave.approve'));
    assert.equal(v.descriptionChanged, true);
    // order in the stored JSON does not matter
    const shuffled = PRESETS.find((x) => x.name === 'Line manager').permissions.slice().reverse();
    assert.ok(mig._planUp(row('Line manager', { permissions: JSON.stringify(shuffled) })));
    // HR edited it: left alone
    assert.equal(mig._planUp(row('HR officer', { permissions: JSON.stringify(['staff.view']) })), null);
    assert.equal(mig._planUp(row('HR officer', { deniedPermissions: '[]' })), null);
    assert.equal(mig._planUp({ name: 'Staff nurse', permissions: '[]', deniedPermissions: '[]' }), null);
    // a renamed description stays the clinic's
    assert.equal(mig._planUp(row('HR manager', { description: 'Ours' })).description, 'Ours');
  });
  test('Nurse in charge keeps …011\'s limits and gains the two new ones', () => {
    const before = { 'staff.view': { kind: 'own' } };
    const v = mig._planUp(row('Nurse in charge', { scopes: JSON.stringify(before) }));
    assert.deepEqual(v.scopes, { 'staff.view': { kind: 'own' }, 'hr.roster': { kind: 'own' }, 'hr.appraisals.run': { kind: 'own' } });
  });
  test('a preset edited in Settings (updatedById set) is left alone, up and down (review S1)', () => {
    assert.equal(mig._planUp(row('HR officer', { updatedById: 3 })), null);
    const up = mig._planUp(row('Line manager'));
    const after = { ...row('Line manager'), permissions: JSON.stringify(up.permissions), scopes: JSON.stringify(up.scopes), description: up.description };
    const done = { scopesBefore: null, descriptionChanged: true };
    assert.ok(mig._planDown(after, done));
    assert.equal(mig._planDown({ ...after, updatedById: 3 }, done), null);
    assert.match(src('migrations/20260928000017-hr-starter-presets-newer-controls.js'), /WHERE createdById IS NULL AND updatedById IS NULL AND status = 'active'/);
  });
  test('down undoes exactly what up wrote, and leaves an edited preset alone', () => {
    const before = { 'staff.view': { kind: 'own' } };
    const r0 = row('Nurse in charge', { scopes: JSON.stringify(before) });
    const up = mig._planUp(r0);
    const done = { scopesBefore: before, descriptionChanged: up.descriptionChanged };
    const after = { ...r0, permissions: JSON.stringify(up.permissions), scopes: JSON.stringify(up.scopes), description: up.description };
    const back = mig._planDown(after, done);
    assert.deepEqual(back.permissions, PRESETS.find((x) => x.name === 'Nurse in charge').permissions);
    assert.deepEqual(back.scopes, before);
    assert.equal(back.description, r0.description);
    assert.equal(mig._planDown({ ...after, permissions: JSON.stringify([...up.permissions, 'cpd.verify']) }, done), null);
    assert.equal(mig._planDown({ ...after, scopes: JSON.stringify(before) }, done), null);
  });
  test('guarded, with a marker-scoped down', () => {
    const s = src(rel);
    assert.match(s, /showAllTables/);
    assert.match(s, /describeTable/);
    assert.match(s, /createdById IS NULL AND updatedById IS NULL AND status = 'active'/);
    assert.match(s.slice(s.indexOf('async down')), /readMarker/);
  });
});
