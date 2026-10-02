const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  cadreForRole, cleanTargets, validateCpd, summariseCpd, DEFAULT_TARGETS,
} = require('../utils/cpd');

describe('cpd — cadreForRole', () => {
  test('the four cadres map to themselves; everything else is staff', () => {
    assert.equal(cadreForRole('doctor'), 'doctor');
    assert.equal(cadreForRole('nurse'), 'nurse');
    assert.equal(cadreForRole('lab'), 'lab');
    assert.equal(cadreForRole('staff'), 'staff');
    assert.equal(cadreForRole('admin'), 'staff');
    assert.equal(cadreForRole('receptionist'), 'staff');
    assert.equal(cadreForRole(undefined), 'staff');
  });
});

describe('cpd — cleanTargets', () => {
  test('fills every cadre, keeps valid numbers, defaults the rest', () => {
    assert.deepEqual(cleanTargets({ doctor: 40, nurse: 25, lab: 15, staff: 5 }), { doctor: 40, nurse: 25, lab: 15, staff: 5 });
    assert.deepEqual(cleanTargets({ doctor: 40 }), { doctor: 40, nurse: DEFAULT_TARGETS.nurse, lab: DEFAULT_TARGETS.lab, staff: DEFAULT_TARGETS.staff });
    assert.deepEqual(cleanTargets({ doctor: -1, nurse: 2000 }), { ...DEFAULT_TARGETS });
  });
  test('accepts a JSON string; rejects junk', () => {
    assert.deepEqual(cleanTargets('{"doctor":50,"nurse":30,"lab":20,"staff":0}'), { doctor: 50, nurse: 30, lab: 20, staff: 0 });
    assert.equal(cleanTargets('not json'), null);
    assert.equal(cleanTargets([1, 2]), null);
  });
});

describe('cpd — validateCpd', () => {
  test('accepts a good entry and rounds points to 1dp', () => {
    const r = validateCpd({ title: '  Foot-care webinar ', date: '2026-02-12', category: 'webinar', points: 5.04, provider: ' KMA ' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { title: 'Foot-care webinar', date: '2026-02-12', category: 'webinar', points: 5, provider: 'KMA' });
  });
  test('title required, date must be ISO, points a non-negative number', () => {
    assert.equal(validateCpd({ title: '', date: '2026-02-12', points: 5 }).error, 'TITLE_REQUIRED');
    assert.equal(validateCpd({ title: 'X', date: '12/02/2026', points: 5 }).error, 'BAD_DATE');
    assert.equal(validateCpd({ title: 'X', date: '2026-02-12', points: -1 }).error, 'BAD_POINTS');
    assert.equal(validateCpd({ title: 'X', date: '2026-02-12', points: 'lots' }).error, 'BAD_POINTS');
  });
  test('unknown category falls back to other; provider optional', () => {
    const r = validateCpd({ title: 'X', date: '2026-02-12', category: 'nonsense', points: 1 });
    assert.equal(r.value.category, 'other');
    assert.equal(r.value.provider, null);
  });
});

describe('cpd — summariseCpd', () => {
  const rows = [
    { status: 'verified', points: '5.0' },
    { status: 'verified', points: 8 },
    { status: 'verified', points: '19.0' },
    { status: 'pending', points: 8 },
    { status: 'rejected', points: 2 },
    { status: 'archived', points: 100 },
  ];
  test('verified counts only verified; pending shown apart; rejected/archived ignored', () => {
    const s = summariseCpd(rows, 50);
    assert.equal(s.verified, 32);
    assert.equal(s.pending, 8);
    assert.equal(s.target, 50);
    assert.equal(s.toTarget, 18);
    assert.equal(s.met, false);
  });
  test('target 0 means no target: met, nothing to go', () => {
    const s = summariseCpd(rows, 0);
    assert.equal(s.target, 0);
    assert.equal(s.toTarget, 0);
    assert.equal(s.met, true);
  });
  test('meeting the target', () => {
    assert.equal(summariseCpd(rows, 30).met, true);
    assert.equal(summariseCpd(rows, 30).toTarget, 0);
  });
});
