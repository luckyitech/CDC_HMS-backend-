const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { countLeaveDays, datesInRange, rangesOverlap } = require('../utils/leaveDays');
const { buildChanges } = require('../utils/auditChanges');
const { generateEmployeeId } = require('../utils/generateId');
const { formatStaff } = require('../controllers/staffController');
const { STAFF_ROLES, DEFAULT_POSITION } = require('../constants/staffRoles');

// =====================================================================
// Staff profiles — the logic worth pinning down.
//
// These are the pieces with a right and a wrong answer that are painful to
// notice in the UI: day counting that is off by one, an audit diff that reports
// unchanged fields, an employee ID that repeats, and expiry warnings that
// disagree between screens. No database required.
// =====================================================================

const inDays = (n) => new Date(Date.now() + n * 86400000);

describe('countLeaveDays', () => {
  test('is inclusive of both ends — Monday to Friday is five days', () => {
    assert.equal(countLeaveDays('2026-08-03', '2026-08-07'), 5);
  });

  test('a single day counts as one', () => {
    assert.equal(countLeaveDays('2026-08-03', '2026-08-03'), 1);
  });

  test('a reversed range is zero, never negative', () => {
    assert.equal(countLeaveDays('2026-08-07', '2026-08-03'), 0);
  });

  test('spans a month boundary', () => {
    assert.equal(countLeaveDays('2026-07-30', '2026-08-02'), 4);
  });

  test('spans a leap day', () => {
    assert.equal(countLeaveDays('2028-02-27', '2028-03-01'), 4);
  });

  // The reason the helper works in UTC. In local time one day in this range is
  // 25 hours long, and a plain division returns 6.
  test('survives a daylight-saving boundary', () => {
    assert.equal(countLeaveDays('2026-10-23', '2026-10-29'), 7);
  });

  test('excludes weekends when asked', () => {
    assert.equal(countLeaveDays('2026-08-03', '2026-08-09', { excludeWeekends: true }), 5);
    assert.equal(countLeaveDays('2026-08-08', '2026-08-09', { excludeWeekends: true }), 0);
  });

  test('accepts Date objects as well as strings', () => {
    assert.equal(countLeaveDays(new Date('2026-08-03'), new Date('2026-08-07')), 5);
  });
});

describe('datesInRange', () => {
  test('yields one entry per day, inclusive', () => {
    assert.deepEqual(datesInRange('2026-08-03', '2026-08-05'),
      ['2026-08-03', '2026-08-04', '2026-08-05']);
  });

  // One DoctorBlock row is written per date, so a mismatch here would either
  // leave a day bookable or block one the person is working.
  test('produces exactly as many dates as days charged', () => {
    assert.equal(datesInRange('2026-08-03', '2026-08-07').length,
      countLeaveDays('2026-08-03', '2026-08-07'));
  });

  test('yields nothing for a reversed range', () => {
    assert.deepEqual(datesInRange('2026-08-07', '2026-08-03'), []);
  });
});

describe('rangesOverlap', () => {
  test('touching on a single day counts as an overlap', () => {
    assert.equal(rangesOverlap('2026-08-01', '2026-08-05', '2026-08-05', '2026-08-09'), true);
  });

  test('adjacent but not touching does not', () => {
    assert.equal(rangesOverlap('2026-08-01', '2026-08-04', '2026-08-05', '2026-08-09'), false);
  });

  test('fully contained counts as an overlap', () => {
    assert.equal(rangesOverlap('2026-08-01', '2026-08-31', '2026-08-10', '2026-08-12'), true);
  });
});

describe('generateEmployeeId', () => {
  const fakeModel = (ids) => ({
    findAll: async () => ids.map((employeeId) => ({ employeeId })),
  });

  test('starts at EMP001', async () => {
    assert.equal(await generateEmployeeId(fakeModel([])), 'EMP001');
  });

  test('continues from the highest existing number', async () => {
    assert.equal(await generateEmployeeId(fakeModel(['EMP001', 'EMP002'])), 'EMP003');
  });

  // The bug documented in generateNumber: 'EMP999' sorts above 'EMP1000' as a
  // string, so comparing as text pins the sequence at 999 and then collides.
  test('compares numerically, so it survives passing 999', async () => {
    assert.equal(await generateEmployeeId(fakeModel(['EMP999', 'EMP1000'])), 'EMP1001');
  });

  test('finds the maximum regardless of row order', async () => {
    assert.equal(await generateEmployeeId(fakeModel(['EMP010', 'EMP003', 'EMP007'])), 'EMP011');
  });
});

describe('buildChanges', () => {
  test('reports only fields that actually changed', () => {
    assert.deepEqual(buildChanges({ a: 1, b: 2 }, { a: 1, b: 3 }), { b: { from: 2, to: 3 } });
  });

  // Sequelize returns numbers where the request body carried strings; a strict
  // comparison would fill the audit log with edits nobody made.
  test('treats 5 and "5" as unchanged', () => {
    assert.deepEqual(buildChanges({ a: 5 }, { a: '5' }), {});
  });

  test('compares objects by value, not identity', () => {
    assert.deepEqual(buildChanges({ a: { x: 1 } }, { a: { x: 1 } }), {});
  });
});

describe('formatStaff', () => {
  const user = {
    id: 7, firstName: 'Amina', lastName: 'Karanja',
    email: 'a@k.com', phone: '070', isActive: true, role: 'doctor',
  };

  test('flags a licence expiring within 60 days without calling it expired', () => {
    const r = formatStaff({ licenseExpiry: inDays(42), roleDetails: {} }, user);
    assert.equal(r.licenceExpiringSoon, true);
    assert.equal(r.licenceExpired, false);
  });

  test('raises nothing for a licence well in date', () => {
    assert.equal(formatStaff({ licenseExpiry: inDays(200), roleDetails: {} }, user).licenceExpiringSoon, false);
  });

  test('flags a lapsed licence as both expiring and expired', () => {
    const r = formatStaff({ licenseExpiry: inDays(-5), roleDetails: {} }, user);
    assert.equal(r.licenceExpired, true);
    assert.equal(r.licenceExpiringSoon, true);
  });

  // Front desk hold no licence — they must not get a permanent warning pill.
  test('raises nothing when there is no licence at all', () => {
    const r = formatStaff({ licenseExpiry: null, roleDetails: {} }, user);
    assert.equal(r.licenceExpiringSoon, false);
    assert.equal(r.licenceExpired, false);
    assert.equal(r.licenceExpiresInDays, null);
  });

  test('derives isArchived from deletedAt', () => {
    assert.equal(formatStaff({ deletedAt: new Date(), roleDetails: {} }, user).isArchived, true);
    assert.equal(formatStaff({ deletedAt: null, roleDetails: {} }, user).isArchived, false);
  });

  test('never returns the password hash', () => {
    const r = formatStaff({ roleDetails: {} }, { ...user, password: 'hashed' });
    assert.equal(r.password, undefined);
  });
});

describe('staff roles', () => {
  test('patients are excluded — they are subjects of records, not staff', () => {
    assert.equal(STAFF_ROLES.includes('patient'), false);
  });

  test('every staff role has a default job title', () => {
    STAFF_ROLES.forEach((role) => {
      assert.ok(DEFAULT_POSITION[role], `no default position for ${role}`);
    });
  });
});
