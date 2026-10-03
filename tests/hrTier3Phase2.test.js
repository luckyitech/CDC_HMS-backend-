// HR Tier 3 Phase 2 — HR reports (T3-3, R-1…R-8). Pure: the rules in
// utils/hrReports, the hr.reports control in the vocabulary, and the CSV
// shapes. Behaviour against a database is proven by the scratch e2e harness.
require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../utils/hrReports');
const {
  PERMISSIONS: P, SCOPABLE, HR_DELEGABLE, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, PRESET_EXCLUDED,
} = require('../constants/permissions');

describe('hr.reports — the control', () => {
  test('defined, scopable, delegable, covered by admin access, presetable', () => {
    assert.equal(P.HR_REPORTS, 'hr.reports');
    assert.ok(SCOPABLE.includes(P.HR_REPORTS));
    assert.ok(HR_DELEGABLE.includes(P.HR_REPORTS));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_REPORTS));
    assert.ok(!PRESET_EXCLUDED.includes(P.HR_REPORTS));
  });
  test('lives in HR Suite · Administration', () => {
    const g = PERMISSION_GROUPS.find((x) => x.key === 'hr-admin');
    assert.ok(g.areas.some((a) => a.access === P.HR_REPORTS));
  });
  test('the routes gate on it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/hr.js'), 'utf8');
    assert.match(src, /const REPORTS = \['admin', 'hr\.reports'\]/);
    assert.match(src, /'\/reports', authenticate, authorize\(\.\.\.REPORTS\)/);
    assert.match(src, /'\/reports\/:report\/download', authenticate, authorize\(\.\.\.REPORTS\)/);
  });
});

describe('scope and departments', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/hrReports.js'), 'utf8');
  test('people come through services/hrScope with hr.reports', () => {
    assert.match(src, /hrScope\.userIdsInScope\(user, PERMISSIONS\.HR_REPORTS\)/);
  });
  test('departments are read by id, never the display text', () => {
    assert.ok(!/attributes: \[[^\]]*'department'[^I]/.test(src), 'StaffProfile.department text must not be read');
    assert.match(src, /'departmentId'/);
  });
});

describe('headcount (R-7)', () => {
  const today = '2026-10-02';
  test('employed: not archived, Active/On Leave/Suspended, end date not passed', () => {
    assert.equal(R.isEmployed({ isActive: true, profile: { employmentStatus: 'Active' } }, today), true);
    assert.equal(R.isEmployed({ isActive: false, profile: { employmentStatus: 'Suspended' } }, today), true);
    assert.equal(R.isEmployed({ isActive: true, profile: { employmentStatus: 'On Leave' } }, today), true);
    assert.equal(R.isEmployed({ isActive: false, profile: { employmentStatus: 'Resigned' } }, today), false);
    assert.equal(R.isEmployed({ isActive: true, profile: { employmentStatus: 'Active', deletedAt: new Date() } }, today), false);
    assert.equal(R.isEmployed({ isActive: true, profile: { employmentStatus: 'Active', endDate: '2026-09-30' } }, today), false);
    assert.equal(R.isEmployed({ isActive: true, profile: { employmentStatus: 'Active', endDate: '2026-10-02' } }, today), true);
    assert.equal(R.isEmployed({ isActive: true, profile: null }, today), true);
    assert.equal(R.isEmployed({ isActive: false, profile: null }, today), false);
  });
  test('department × cadre, leave owed summed, No department last, archived entries keep their name', () => {
    const depts = [{ id: 1, name: 'Laboratory' }, { id: 2, name: 'Diabetes clinic' }];
    const t = R.headcountTable([
      { role: 'doctor', departmentId: 2, leaveOwed: 10 },
      { role: 'nurse', departmentId: 2, leaveOwed: 5.5 },
      { role: 'lab', departmentId: 1, leaveOwed: 3 },
      { role: 'staff', departmentId: null, leaveOwed: 1 },
      { role: 'admin', departmentId: 99, leaveOwed: 0 },   // unknown id → No department
    ], depts);
    assert.deepEqual(t.rows.map((r) => r.name), ['Diabetes clinic', 'Laboratory', 'No department']);
    assert.equal(t.rows[0].counts.doctor, 1);
    assert.equal(t.rows[0].counts.nurse, 1);
    assert.equal(t.rows[0].leaveOwed, 15.5);
    assert.equal(t.rows[2].total, 2);
    assert.equal(t.totals.total, 5);
    assert.equal(t.totals.leaveOwed, 19.5);
    assert.equal(t.totals.counts.admin, 1);
  });
  test('an unknown role counts as front office', () => assert.equal(R.cadreOf('pharmacist'), 'staff'));
  test('movement by start and end dates in the year, sorted', () => {
    const m = R.movement([
      { name: 'A', profile: { startDate: '2026-03-01' } },
      { name: 'B', profile: { startDate: '2025-03-01', endDate: '2026-06-30' } },
      { name: 'C', profile: { startDate: '2026-01-15' } },
      { name: 'D', profile: { startDate: new Date('2024-01-01T00:00:00Z') } },
    ], 2026);
    assert.deepEqual(m.joined.map((p) => p.name), ['C', 'A']);
    assert.deepEqual(m.left.map((p) => p.name), ['B']);
  });
});

describe('leave and sick (R-3, R-8)', () => {
  test('annual line: owed = remaining, never negative; unlimited owes nothing', () => {
    const l = R.annualLine([{ leaveType: 'Annual', entitled: '21', carriedIn: 2, taken: 5, booked: 3, remaining: 15 }]);
    assert.deepEqual(l, { entitled: 21, carriedIn: 2, taken: 5, booked: 3, remaining: 15, owed: 15 });
    assert.equal(R.annualLine([{ leaveType: 'Annual', entitled: 5, taken: 7, booked: 0, remaining: -2 }]).owed, 0);
    assert.equal(R.annualLine([{ leaveType: 'Annual', unlimited: true, taken: 1, booked: 0 }]).owed, 0);
    assert.equal(R.annualLine([{ leaveType: 'Sick', taken: 1 }]), null);
  });
  test('private taken sums only the private types', () => {
    assert.equal(R.privateTaken([{ leaveType: 'Sick', taken: 2.5 }, { leaveType: 'Annual', taken: 9 }], new Set(['Sick'])), 2.5);
  });
  test('the sick total is hidden under five people', () => {
    assert.deepEqual(R.sickTotal(3, 4), { hidden: true, days: null, people: 4, minimum: 5 });
    assert.deepEqual(R.sickTotal(3.333, 5), { hidden: false, days: 3.33, people: 5, minimum: 5 });
  });
});

describe('CPD (R-5)', () => {
  test('share of the year', () => {
    assert.equal(R.yearElapsed(2025, '2026-10-02'), 1);
    assert.equal(R.yearElapsed(2027, '2026-10-02'), 0);
    const f = R.yearElapsed(2026, '2026-07-02');
    assert.ok(f > 0.49 && f < 0.51, String(f));
  });
  test('met / on track / behind / no target', () => {
    assert.equal(R.cpdStanding({ verified: 50, pending: 0, target: 50 }, 2026, '2026-03-01').status, 'met');
    assert.equal(R.cpdStanding({ verified: 26, pending: 0, target: 50 }, 2026, '2026-07-02').status, 'on_track');
    assert.equal(R.cpdStanding({ verified: 20, pending: 30, target: 50 }, 2026, '2026-07-02').status, 'behind');
    assert.equal(R.cpdStanding({ verified: 49, pending: 0, target: 50 }, 2025, '2026-01-10').status, 'behind');
    assert.equal(R.cpdStanding({ verified: 0, pending: 0, target: 0 }, 2026, '2026-07-02').status, 'no_target');
    assert.equal(R.cpdStanding({ verified: 0, pending: 0, target: 30 }, 2026, '2026-07-02').expectedByNow, 15);
  });
});

describe('expiries (R-6)', () => {
  test('window choices, default 90', () => {
    assert.equal(R.cleanWindow('30'), 30);
    assert.equal(R.cleanWindow('45'), 90);
    assert.equal(R.cleanWindow(undefined), 90);
  });
  test('expired always in, then within the window, soonest first', () => {
    const rows = R.expiryRows([
      { item: 'far', expiryDate: '2027-06-01' },
      { item: 'soon', expiryDate: '2026-10-20' },
      { item: 'old', expiryDate: '2024-01-01' },
      { item: 'date obj', expiryDate: new Date('2026-12-01T00:00:00Z') },
      { item: 'none', expiryDate: null },
    ], '2026-10-02', 90);
    assert.deepEqual(rows.map((r) => r.item), ['old', 'soon', 'date obj']);
    assert.equal(rows[0].status, 'expired');
    assert.equal(rows[1].status, 'due');
    assert.equal(rows[2].expiryDate, '2026-12-01');
  });
});

describe('punctuality (R-4)', () => {
  test('on time = gold + green check-in stars', () => {
    const line = R.punctualityLine({
      stars: { in: { gold: 2, green: 5, red: 3, pending: 0 } },
      calendar: [{ absent: true }, { absent: false }, { absent: true }],
      table: { workingDays: { soFar: 12, worked: 10, leave: 1 }, lateCount: 3, lateMinutesTotal: 50, earlyOutCount: 1, missedCheckouts: 2 },
    });
    assert.equal(line.onTime, 7);
    assert.equal(line.late, 3);
    assert.equal(line.onTimeRate, 70);
    assert.equal(line.avgLateMinutes, 17);
    assert.equal(line.noCheckIn, 2);
  });
  test('no judged days → no rate', () => {
    const line = R.punctualityLine({
      stars: { in: { gold: 0, green: 0, red: 0, pending: 0 } }, calendar: [],
      table: { workingDays: { soFar: 0, worked: 0, leave: 0 }, lateCount: 0, lateMinutesTotal: 0, earlyOutCount: 0, missedCheckouts: 0 },
    });
    assert.equal(line.onTimeRate, null);
  });
});

describe('the downloads (R-2, R-3)', () => {
  const { CSV, REPORTS } = require('../controllers/hrReportsController');
  const data = {
    today: '2026-10-02', year: 2026, month: '2026-10', window: 90, cadres: R.CADRES,
    headcount: R.headcountTable([{ role: 'doctor', departmentId: 1, leaveOwed: 4 }], [{ id: 1, name: '=Clinic' }]),
    movement: { joined: [{ name: 'A', role: 'nurse', date: '2026-01-01', department: null }], left: [] },
    leave: { people: [{ name: 'A', role: 'nurse', annual: R.annualLine([{ leaveType: 'Annual', entitled: 21, carriedIn: 0, taken: 1, booked: 0, remaining: 20 }]) }], sick: { hidden: false, days: 9, people: 6 } },
    expiries: { rows: [{ name: 'A', role: 'nurse', item: 'BLS', expiryDate: '2026-10-20', daysLeft: 18, status: 'due' }] },
    cpd: { people: [{ name: 'A', role: 'nurse', target: 30, verified: 10, pending: 2, expectedByNow: 22.5, status: 'behind' }] },
    punctuality: { people: [{ name: 'A', role: 'nurse', workingDays: 2, daysWorked: 2, leaveDays: 0, onTime: 1, late: 1, onTimeRate: 50, avgLateMinutes: 4, earlyOut: 0, missedCheckouts: 0, noCheckIn: 0 }] },
  };
  test('six downloads, each a table with as many cells as headers', () => {
    assert.deepEqual(REPORTS, ['headcount', 'movement', 'leave', 'expiries', 'cpd', 'punctuality']);
    for (const key of REPORTS) {
      const { headers, rows } = CSV[key].table(data);
      assert.ok(rows.length >= 1, key);
      rows.forEach((r) => assert.equal(r.length, headers.length, key));
    }
  });
  test('no download carries sick leave', () => {
    for (const key of REPORTS) {
      const { headers, rows } = CSV[key].table(data);
      const text = JSON.stringify([headers, rows]).toLowerCase();
      assert.ok(!text.includes('sick'), key);
    }
  });
  test('formula cells are defused on the way out', () => {
    const { csvText } = require('../utils/csv');
    const { headers, rows } = CSV.headcount.table(data);
    assert.match(csvText(headers, rows), /'=Clinic/);
  });
});
