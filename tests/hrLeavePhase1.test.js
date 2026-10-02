const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../utils/leavePolicyRules');
const { resolveExpected } = require('../utils/workHours');
const { dayCell, monthSummary, streakNoRed } = require('../utils/attendanceRules');
const { PERMISSIONS, PERMISSION_GROUPS, ADMIN_ACCESS_COVERS } = require('../constants/permissions');

// =====================================================================
// B27 phase 1 — Leave settings (28 Sep 2026). No database.
// Spec: claude/hr-leave-and-my-profile-build-spec.md §6 (HR), §9 mockup 1 +
// revisions A, C, D, §10 phase 1, §11 (a finished year is frozen).
// =====================================================================

const ACTIVE = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];
const WEEK = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
const goodBody = () => ({
  weekWeights: { ...WEEK },
  countingMode: 'clinic_week',
  allowNegative: false,
  proRate: true,
  carryExpiry: '03-31',
  minNoticeDays: 14,
  maxCadreAwayPerDay: 1,
  blockDoctorSlots: true,
  visibleTypes: ['Annual', 'Sick'],
  types: {
    Annual:    { days: 21, countedAs: 'working', grant: 'up_front', carryCap: 5, halfDaysAllowed: true, docRule: 'never', enabled: true },
    Sick:      { days: 14, countedAs: 'working', grant: 'up_front', carryCap: 0, halfDaysAllowed: true, docRule: 'over_days', docOverDays: 2, enabled: true },
    Maternity: { days: 90, countedAs: 'calendar', grant: 'per_event', halfDaysAllowed: false, docRule: 'always', enabled: true },
    Unpaid:    { days: 5, countedAs: 'working', grant: 'unlimited', halfDaysAllowed: true, docRule: 'never', enabled: true },
  },
});
const readRoute = (file) => fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');

describe('validatePolicy — what HR may save', () => {
  test('a complete policy is clean; unlimited drops its days; holidays are always excluded', () => {
    const r = rules.validatePolicy({ ...goodBody(), excludeHolidays: false }, { activeKeys: ACTIVE });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.value.types.Unpaid.days, null);
    assert.equal(r.value.excludeHolidays, true);
    assert.equal(r.value.types.Sick.docOverDays, 2);
    assert.equal(r.value.types.Maternity.carryCap, 0, 'per-event types never carry');
  });
  test('Saturday may be a full day, a half day or nothing — but not 0.3', () => {
    for (const v of [1, 0.5, 0]) {
      assert.equal(rules.validatePolicy({ ...goodBody(), weekWeights: { ...WEEK, 6: v } }, { activeKeys: ACTIVE }).ok, true, String(v));
    }
    const bad = rules.validatePolicy({ ...goodBody(), weekWeights: { ...WEEK, 6: 0.3 } }, { activeKeys: ACTIVE });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /Saturday/);
  });
  test('a week where nothing counts is refused', () => {
    const r = rules.validatePolicy({ ...goodBody(), weekWeights: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } }, { activeKeys: ACTIVE });
    assert.equal(r.ok, false);
  });
  test('carry expiry must be a real MM-DD, or blank for never', () => {
    assert.equal(rules.validatePolicy({ ...goodBody(), carryExpiry: '' }, { activeKeys: ACTIVE }).value.carryExpiry, null);
    assert.equal(rules.validatePolicy({ ...goodBody(), carryExpiry: '02-30' }, { activeKeys: ACTIVE }).ok, false);
    assert.equal(rules.validatePolicy({ ...goodBody(), carryExpiry: '31 Mar' }, { activeKeys: ACTIVE }).ok, false);
    assert.equal(rules.validatePolicy({ ...goodBody(), carryExpiry: '02-29' }, { activeKeys: ACTIVE }).ok, true);
  });
  test('a yearly type needs its days; quarter days only; the carry cap never exceeds the allowance', () => {
    const b = goodBody();
    b.types.Annual.days = '';
    assert.match(rules.validatePolicy(b, { activeKeys: ACTIVE }).errors[0], /Annual: enter the number of days/);
    b.types.Annual.days = 21.3;
    assert.match(rules.validatePolicy(b, { activeKeys: ACTIVE }).errors[0], /quarter/);
    b.types.Annual.days = 21;
    b.types.Annual.carryCap = 30;
    assert.match(rules.validatePolicy(b, { activeKeys: ACTIVE }).errors[0], /carry cap/);
  });
  test('calendar-day leave cannot allow half days', () => {
    const b = goodBody();
    b.types.Maternity.halfDaysAllowed = true;
    assert.match(rules.validatePolicy(b, { activeKeys: ACTIVE }).errors[0], /half days/);
  });
  test('"needs a document over N days" needs the N', () => {
    const b = goodBody();
    b.types.Sick.docOverDays = null;
    assert.equal(rules.validatePolicy(b, { activeKeys: ACTIVE }).ok, false);
  });
  test('an unknown or retired type is refused, in the rows and in visible types', () => {
    assert.equal(rules.validatePolicy({ ...goodBody(), visibleTypes: ['Sabbatical'] }, { activeKeys: ACTIVE }).ok, false);
    const b = goodBody();
    b.types.Sabbatical = { days: 5, grant: 'up_front' };
    assert.equal(rules.validatePolicy(b, { activeKeys: ACTIVE }).ok, false);
  });
  test('notice and the cadre warning are bounded integers (blank cadre = no warning)', () => {
    assert.equal(rules.validatePolicy({ ...goodBody(), minNoticeDays: -1 }, { activeKeys: ACTIVE }).ok, false);
    assert.equal(rules.validatePolicy({ ...goodBody(), maxCadreAwayPerDay: 0 }, { activeKeys: ACTIVE }).ok, false);
    assert.equal(rules.validatePolicy({ ...goodBody(), maxCadreAwayPerDay: '' }, { activeKeys: ACTIVE }).value.maxCadreAwayPerDay, null);
  });
});

describe('editability — a finished year is frozen', () => {
  const today = '2026-09-28';
  test('this year: a draft can be edited and published; a published one edited, not re-published', () => {
    assert.deepEqual(
      (({ canEdit, canPublish }) => ({ canEdit, canPublish }))(rules.editability({ year: 2026, today, policy: { status: 'draft' } })),
      { canEdit: true, canPublish: true },
    );
    const pub = rules.editability({ year: 2026, today, policy: { status: 'published' } });
    assert.equal(pub.canEdit, true);
    assert.equal(pub.canPublish, false);
  });
  test('a year that has ended cannot be edited, published or created — whatever its status', () => {
    for (const policy of [{ status: 'published' }, { status: 'draft' }, null]) {
      const e = rules.editability({ year: 2025, today, policy });
      assert.equal(e.canEdit || e.canPublish || e.canCreate, false);
      assert.equal(e.code, 'POLICY_YEAR_ENDED');
      assert.match(e.reason, /override/);
    }
  });
  test('next year can be started; three years ahead cannot', () => {
    assert.equal(rules.editability({ year: 2027, today, policy: null }).canCreate, true);
    assert.equal(rules.editability({ year: 2028, today, policy: null }).canCreate, true);
    assert.equal(rules.editability({ year: 2029, today, policy: null }).code, 'POLICY_YEAR_TOO_FAR');
  });
  test('on 1 January the old year freezes', () => {
    assert.equal(rules.editability({ year: 2026, today: '2027-01-01', policy: { status: 'published' } }).canEdit, false);
    assert.equal(rules.editability({ year: 2026, today: '2026-12-31', policy: { status: 'published' } }).canEdit, true);
  });
});

describe('publishProblems', () => {
  const policy = (types, visibleTypes = ACTIVE) => ({ types, visibleTypes });
  test('something must be switched on and visible', () => {
    assert.ok(rules.publishProblems(policy({ Annual: { enabled: false, grant: 'up_front', days: 21 } }), ACTIVE).length > 0);
    assert.ok(rules.publishProblems(policy({ Annual: { enabled: true, grant: 'up_front', days: 21 } }, ['Sick']), ACTIVE).length > 0);
    assert.deepEqual(rules.publishProblems(policy({ Annual: { enabled: true, grant: 'up_front', days: 21 } }), ACTIVE), []);
  });
  test('a switched-on yearly type without days blocks publishing', () => {
    assert.match(rules.publishProblems(policy({ Annual: { enabled: true, grant: 'up_front', days: null } }), ACTIVE)[0], /Annual/);
  });
});

describe('typeKeyFor — keys for types HR adds', () => {
  test('PascalCase from the name, unique case-insensitively', () => {
    assert.equal(rules.typeKeyFor('Hajj leave', ACTIVE), 'HajjLeave');
    assert.equal(rules.typeKeyFor('annual', ACTIVE), 'Annual2');
    assert.equal(rules.typeKeyFor('Study / exam', ACTIVE), 'StudyExam');
    assert.equal(rules.typeKeyFor('   ', ACTIVE), null);
    assert.equal(rules.typeKeyFor('2nd sabbatical', ACTIVE), null);
    assert.ok(rules.typeKeyFor('x'.repeat(200), []).length <= 40);
  });
});

describe('cleanWeek — a person\'s own week (revision A)', () => {
  test('seven values from 1 / ½ / 0, at least one working day; null clears', () => {
    assert.deepEqual(rules.cleanWeek({ 0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0 }).value, { 0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0 });
    assert.equal(rules.cleanWeek(null).value, null);
    assert.equal(rules.cleanWeek({ 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }).ok, false);
    assert.equal(rules.cleanWeek({ 1: 1 }).ok, false);
  });
});

describe('attendance: a public holiday is no expected hours', () => {
  const defaults = { '1-5': ['08:00', '17:00'], 6: ['08:00', '13:00'], 0: 'off' };
  test('the default week gives way to the holiday', () => {
    const r = resolveExpected({ rows: [], clinicDate: '2026-10-20', defaults, holiday: 'Mashujaa Day' });
    assert.equal(r.source, 'holiday');
    assert.equal(r.startAt, null);
    assert.equal(r.holiday, 'Mashujaa Day');
  });
  test('a person\'s weekly hours give way too', () => {
    const rows = [{ weekday: 2, startTime: '07:00', endTime: '15:00', status: 'active' }];
    assert.equal(resolveExpected({ rows, clinicDate: '2026-10-20', defaults, holiday: 'Mashujaa Day' }).source, 'holiday');
  });
  test('hours HR set for that very date win — someone rostered on the holiday', () => {
    const rows = [{ date: '2026-10-20', startTime: '09:00', endTime: '13:00', status: 'active' }];
    const r = resolveExpected({ rows, clinicDate: '2026-10-20', defaults, holiday: 'Mashujaa Day' });
    assert.equal(r.source, 'date');
    assert.equal(r.start, '09:00');
  });
  test('no holiday → unchanged', () => {
    assert.equal(resolveExpected({ rows: [], clinicDate: '2026-10-21', defaults }).start, '08:00');
  });
  test('the calendar cell: marked H, never absent; coming in still earns stars', () => {
    const day = { date: '2026-10-20', expectedStart: null, onLeave: false, holiday: 'Mashujaa Day' };
    const empty = dayCell(day, [], '2026-10-28');
    assert.equal(empty.holiday, 'Mashujaa Day');
    assert.equal(empty.absent, false);
    const worked = dayCell(day, [{ status: 'closed', checkInPunctuality: 'none', checkOutPunctuality: 'none' }], '2026-10-28');
    assert.equal(worked.holiday, 'Mashujaa Day');
    assert.equal(worked.absent, false);
  });
  test('a holiday neither breaks a streak nor counts as a working day', () => {
    const days = [
      { date: '2026-10-19', expectedStart: '08:00', expectedEnd: '17:00', onLeave: false },
      { date: '2026-10-20', expectedStart: null, expectedEnd: null, onLeave: false, holiday: 'Mashujaa Day' },
      { date: '2026-10-21', expectedStart: '08:00', expectedEnd: '17:00', onLeave: false },
    ];
    const rows = [
      { clinicDate: '2026-10-19', status: 'closed', checkInAt: '2026-10-19T05:00:00Z', checkOutAt: '2026-10-19T14:00:00Z', checkInPunctuality: 'on_time', checkOutPunctuality: 'on_time' },
      { clinicDate: '2026-10-21', status: 'closed', checkInAt: '2026-10-21T05:00:00Z', checkOutAt: '2026-10-21T14:00:00Z', checkInPunctuality: 'on_time', checkOutPunctuality: 'on_time' },
    ];
    assert.equal(streakNoRed({ days, rows, today: '2026-10-21' }), 2);
    const m = monthSummary({ month: '2026-10', days, rows, today: '2026-10-21' });
    assert.equal(m.table.workingDays.total, 2);
  });
});

describe('permissions: the HR Suite card and the new routes (revision C)', () => {
  test('confidential staff documents now sit on the HR Suite card — still outside admin.access', () => {
    const hr = PERMISSION_GROUPS.find((g) => g.key === 'hr');
    assert.ok(hr.areas.some((a) => a.access === PERMISSIONS.HR_CONFIDENTIAL));
    const elsewhere = PERMISSION_GROUPS.filter((g) => g.key !== 'hr').flatMap((g) => g.areas).some((a) => a.access === PERMISSIONS.HR_CONFIDENTIAL);
    assert.equal(elsewhere, false, 'one card per capability');
    assert.equal(ADMIN_ACCESS_COVERS.includes(PERMISSIONS.HR_CONFIDENTIAL), false);
  });
  test('every /api/leave settings route is gated on leave.policy and nothing wider', () => {
    const src = readRoute('leave.js');
    assert.match(src, /const POLICY = \['admin', 'leave\.policy'\];/);
    // Phase 3 added the approvals inbox and requests to this file under their
    // own gate (PARTICIPATE); every SETTINGS route stays leave.policy.
    const routes = src.split('\n').filter((l) => /^router\.(get|put|post|patch|delete)\(/.test(l));
    // Phase 5 added the team calendar under the same PARTICIPATE gate.
    const approvals = routes.filter((l) => /'\/(inbox|requests|calendar)/.test(l));
    const settings = routes.filter((l) => !approvals.includes(l));
    assert.ok(settings.length >= 12);
    for (const line of settings) assert.match(line, /authenticate, authorize\(\.\.\.POLICY\)/, line);
    for (const line of approvals) assert.match(line, /authenticate, authorize\(\.\.\.PARTICIPATE\)/, line);
  });
  test('whoever may change HR settings may also read them (the Alerts tab)', () => {
    const src = readRoute('hr.js');
    assert.match(src, /router\.get\('\/settings', authenticate, authorize\(\.\.\.SETTINGS_READ\)/);
    assert.match(src, /const SETTINGS_READ = \['admin', 'hr\.view', 'hr\.settings'\];/);
  });
});
