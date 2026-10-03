// HR Tier 3 Phase 4 — the shift roster (T3-5/6/7 a, RO-1…RO-12). Pure: the
// rules in utils/roster, night shifts in the working-hours resolver, the tap
// and the sweep, the two new controls, and the roster service's guard rails.
// DB behaviour is proven by the scratch e2e harness.
require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../utils/roster');
const { resolveExpected, spanMinutes } = require('../utils/workHours');
const { monthSummary } = require('../utils/attendanceRules');
const { isStale } = require('../services/hrAttendanceSweep');
const { ALERT_EVENTS } = require('../utils/hrConfig');
const {
  PERMISSIONS: P, SCOPABLE, HR_DELEGABLE, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, PRESET_EXCLUDED,
} = require('../constants/permissions');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the controls (T3-8, RO-2)', () => {
  test('hr.roster: scopable, delegable, admin access', () => {
    assert.equal(P.HR_ROSTER, 'hr.roster');
    assert.ok(SCOPABLE.includes(P.HR_ROSTER));
    assert.ok(HR_DELEGABLE.includes(P.HR_ROSTER));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_ROSTER));
    assert.ok(!PRESET_EXCLUDED.includes(P.HR_ROSTER));
  });
  test('hr.roster.shifts: clinic-wide, delegable, admin access', () => {
    assert.ok(!SCOPABLE.includes(P.HR_ROSTER_SHIFTS));
    assert.ok(HR_DELEGABLE.includes(P.HR_ROSTER_SHIFTS));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_ROSTER_SHIFTS));
  });
  test('both on the Attendance card', () => {
    const g = PERMISSION_GROUPS.find((x) => x.key === 'hr-attendance');
    assert.ok(g.areas.some((a) => a.access === P.HR_ROSTER));
    assert.ok(g.areas.some((a) => a.access === P.HR_ROSTER_SHIFTS));
  });
  test('every roster list and action asks the hr.roster scope', () => {
    const s = src('services/roster.js');
    assert.match(s, /hrScope\.userIdsInScope\(user, HR_ROSTER\)/);
    assert.match(s, /hrScope\.scopeOf\(user, HR_ROSTER\)/);
    for (const fn of ['weekView', 'setCell', 'copyLastWeek', 'setMinCover', 'publish']) {
      const body = s.slice(s.indexOf(`const ${fn} = async`));
      assert.match(body.slice(0, 600), /await assertDepartment\(user, departmentId\)/, fn);
    }
  });
  test('my shifts are published only and name no other person', () => {
    const s = src('services/roster.js');
    const body = s.slice(s.indexOf('const myShifts'));
    assert.match(body, /publishedAt: \{ \[Op\.ne\]: null \}/);
    assert.match(src('routes/hrSelf.js'), /router\.get\('\/roster', authenticate, authorize\(\.\.\.SELF\), hrRoster\.mine\)/);
  });
  test('roster alerts exist and carry no shift detail', () => {
    assert.ok(ALERT_EVENTS.includes('roster_published'));
    assert.ok(ALERT_EVENTS.includes('roster_changed'));
    const s = src('services/roster.js');
    for (const m of s.matchAll(/hrNotify\.notify\('roster_\w+', \{([\s\S]*?)\}\)/g)) {
      assert.doesNotMatch(m[1], /startTime|endTime|leave/i);
    }
  });
});

describe('weeks and shift types (RO-1, RO-3)', () => {
  test('mondayOf / weekDates', () => {
    assert.equal(R.mondayOf('2026-11-11'), '2026-11-09');
    assert.equal(R.mondayOf('2026-11-15'), '2026-11-09'); // Sunday
    assert.equal(R.mondayOf('2026-11-09'), '2026-11-09');
    assert.ok(R.isMonday('2026-11-09'));
    assert.ok(!R.isMonday('2026-11-10'));
    assert.deepEqual(R.weekDates('2026-12-28'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });
  test('roster roles: nurses, lab, front office — never doctors (T3-6 a)', () => {
    assert.deepEqual(R.ROSTER_ROLES, ['nurse', 'lab', 'staff']);
    assert.ok(!R.isRosterRole('doctor'));
    assert.ok(!R.isRosterRole('admin'));
  });
  test('shift types are cleaned', () => {
    assert.equal(R.cleanShiftType({ name: '', startTime: '07:00', endTime: '14:00' }).error, 'NAME_REQUIRED');
    assert.equal(R.cleanShiftType({ name: 'Morning', startTime: '7:00', endTime: '14:00' }).error, 'BAD_TIME');
    assert.equal(R.cleanShiftType({ name: 'Morning', startTime: '07:00', endTime: '07:00' }).error, 'SAME_TIME');
    assert.equal(R.cleanShiftType({ name: 'Morning', startTime: '07:00', endTime: '14:00', colour: 'pink' }).error, 'BAD_COLOUR');
    assert.deepEqual(R.cleanShiftType({ name: '  Night  shift ', startTime: '19:00:00', endTime: '07:00' }).value,
      { name: 'Night shift', startTime: '19:00', endTime: '07:00', colour: 'blue' });
    assert.deepEqual(R.cleanShiftType({ status: 'archived' }, { partial: true }).value, { status: 'archived' });
  });
  test('length and overnight', () => {
    assert.equal(R.minutesOf({ startTime: '07:00', endTime: '14:00' }), 420);
    assert.equal(R.minutesOf({ startTime: '19:00', endTime: '07:00' }), 720);
    assert.equal(R.minutesOf({ isOff: true }), 0);
    assert.ok(R.isOvernight({ startTime: '19:00', endTime: '07:00' }));
    assert.ok(!R.isOvernight({ startTime: '07:00', endTime: '19:00' }));
    assert.equal(spanMinutes('22:00', '06:00'), 480);
  });
  test('a cell becomes dated working hours (T3-5 a)', () => {
    assert.deepEqual(R.workHoursOf({ isOff: false, startTime: '19:00', endTime: '07:00' }), { startTime: '19:00', endTime: '07:00', isOff: false });
    assert.deepEqual(R.workHoursOf({ isOff: true }), { startTime: null, endTime: null, isOff: true });
  });
});

describe('warnings, never blocks (T3-7 a, RO-8)', () => {
  const dates = R.weekDates('2026-11-09');
  test('rest under 11 h after a night shift', () => {
    const w = R.warningsFor({ dates, cells: [
      { UserId: 2, date: '2026-11-10', startTime: '19:00', endTime: '07:00' },
      { UserId: 2, date: '2026-11-11', startTime: '14:00', endTime: '21:00' },
    ] });
    assert.deepEqual(w, [{ kind: 'rest', userId: 2, date: '2026-11-11', hours: 7 }]);
  });
  test('11 h or more is fine; Off never counts', () => {
    const w = R.warningsFor({ dates, cells: [
      { UserId: 2, date: '2026-11-10', startTime: '07:00', endTime: '14:00' },
      { UserId: 2, date: '2026-11-11', startTime: '07:00', endTime: '14:00' },
      { UserId: 2, date: '2026-11-12', isOff: true },
    ] });
    assert.deepEqual(w, []);
  });
  test('the day before the week counts for rest, but is not itself warned', () => {
    const w = R.warningsFor({ dates, cells: [
      { UserId: 3, date: '2026-11-08', startTime: '19:00', endTime: '07:00' },
      { UserId: 3, date: '2026-11-09', startTime: '07:00', endTime: '14:00' },
    ] });
    assert.deepEqual(w, [{ kind: 'rest', userId: 3, date: '2026-11-09', hours: 0 }]);
  });
  test('cover below the minimum, counted only for the people shown', () => {
    const cells = dates.map((date) => ({ UserId: 2, date, startTime: '07:00', endTime: '14:00' }));
    cells.push({ UserId: 9, date: '2026-11-09', startTime: '07:00', endTime: '14:00' });
    const w = R.warningsFor({ dates, cells, minCover: 2, people: [2, 4] }).filter((x) => x.kind === 'cover');
    assert.equal(w.length, 7);
    assert.deepEqual(w[0], { kind: 'cover', date: '2026-11-09', count: 1, min: 2 });
    assert.deepEqual(R.warningsFor({ dates, cells, minCover: 0 }), []);
  });
  test('a shift on approved leave', () => {
    const w = R.warningsFor({ dates, cells: [{ UserId: 5, date: '2026-11-12', startTime: '07:00', endTime: '14:00' }], leave: new Set(['5|2026-11-12']) });
    assert.deepEqual(w, [{ kind: 'leave', userId: 5, date: '2026-11-12' }]);
  });
});

describe('copy last week (RO-9)', () => {
  test('only empty cells, today onward, never onto leave, only the grid', () => {
    const previous = [
      { UserId: 1, date: '2026-11-02', shiftTypeId: 1, startTime: '07:00', endTime: '14:00' },
      { UserId: 1, date: '2026-11-03', shiftTypeId: 1, startTime: '07:00', endTime: '14:00' },
      { UserId: 1, date: '2026-11-04', isOff: true },
      { UserId: 2, date: '2026-11-05', shiftTypeId: 2, startTime: '19:00', endTime: '07:00' },
      { UserId: 7, date: '2026-11-05', shiftTypeId: 2, startTime: '19:00', endTime: '07:00' },
      { UserId: 2, date: '2026-11-06', shiftTypeId: 1, startTime: '07:00', endTime: '14:00' },
    ];
    const plan = R.copyPlan({
      previous, existing: [{ UserId: 1, date: '2026-11-11' }], today: '2026-11-10',
      leave: new Set(['2|2026-11-13']), people: [1, 2],
    });
    assert.deepEqual(plan.map((p) => `${p.UserId}|${p.date}|${p.isOff ? 'off' : p.shiftTypeId}`), ['1|2026-11-10|1', '2|2026-11-12|2']);
  });
});

describe('night shifts in attendance (RO-12)', () => {
  const night = [{ status: 'active', date: '2026-11-10', startTime: '19:00:00', endTime: '07:00:00', isOff: false }];
  test('a dated night row ends the next morning', () => {
    const e = resolveExpected({ rows: night, clinicDate: '2026-11-10', defaults: null, graceDefault: 5 });
    assert.equal(e.source, 'date');
    assert.equal(e.start, '19:00');
    assert.equal(e.end, '07:00');
    assert.ok(e.overnight);
    assert.equal(e.endAt - e.startAt, 12 * 3600 * 1000);
  });
  test('weekly rows and the default still never run past midnight', () => {
    const weekly = [{ status: 'active', weekday: 2, date: null, startTime: '19:00', endTime: '07:00', isOff: false }];
    const e = resolveExpected({ rows: weekly, clinicDate: '2026-11-10', defaults: null });
    assert.equal(e.startAt, null);
  });
  test('a rostered shift beats a public holiday', () => {
    const e = resolveExpected({ rows: night, clinicDate: '2026-11-10', defaults: null, holiday: 'Some Day' });
    assert.equal(e.source, 'date');
  });
  test('expected minutes in the month count a night shift whole', () => {
    const s = monthSummary({ month: '2026-11', days: [{ date: '2026-11-10', expectedStart: '19:00', expectedEnd: '07:00', onLeave: false }], rows: [], today: '2026-11-30' });
    assert.equal(s.table.expectedMinutes, 720);
  });
  test('the sweep leaves an open night session alone until 6 h after its end', () => {
    const endAt = new Date('2026-11-11T04:00:00Z'); // 07:00 Nairobi on the 11th
    const row = { clinicDate: '2026-11-10', expectedOutAt: endAt };
    assert.equal(isStale(row, '2026-11-11', new Date('2026-11-10T21:30:00Z')), false); // 00:30
    assert.equal(isStale(row, '2026-11-11', new Date('2026-11-11T09:30:00Z')), false); // 12:30
    assert.equal(isStale(row, '2026-11-11', new Date('2026-11-11T10:30:00Z')), true);  // 13:30
  });
  test('a day session is still stale from midnight, as before', () => {
    const row = { clinicDate: '2026-11-10', expectedOutAt: new Date('2026-11-10T14:00:00Z') };
    assert.equal(isStale(row, '2026-11-11', new Date('2026-11-10T21:05:00Z')), true);
    assert.equal(isStale({ clinicDate: '2026-11-10', expectedOutAt: null }, '2026-11-11', new Date('2026-11-10T21:05:00Z')), true);
    assert.equal(isStale({ clinicDate: '2026-11-11', expectedOutAt: null }, '2026-11-11'), false);
  });
  test('the tap looks for last night\'s session when there is none today', () => {
    assert.match(src('controllers/hrAttendanceController.js'), /\|\| \(await svc\.overnightSession\(me\.id, clinicDate, now, transaction\)\)/);
  });
});

describe('the migration', () => {
  test('…013 creates three tables and refuses a lossy down', () => {
    const s = src('migrations/20260928000013-hr-shift-roster.js');
    for (const t of ['RosterShiftTypes', 'RosterWeeks', 'RosterShifts']) assert.match(s, new RegExp(`createTable\\('${t}'`));
    assert.match(s, /down refused/);
  });
});
