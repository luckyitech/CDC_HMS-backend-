const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUESTABLE, validateRequest, cleanContact, currentValue, normalise, todoItems,
} = require('../utils/profileChange');
const { ACCESS_KEYS } = require('../controllers/hrProfileController');
const { PERMISSIONS, ADMIN_ACCESS_COVERS } = require('../constants/permissions');
const { ALERT_EVENTS } = require('../utils/hrConfig');

// =====================================================================
// B27 phase 4 (My profile) — 28 Sep 2026. No database.
//   - what a person may save themselves (contact) and what they must ask
//     HR to change (identity, licence, qualifications);
//   - email, position, department, status are never self-editable;
//   - the self view never carries access internals;
//   - the routes' gates: self routes for every staff role, deciding is
//     hr.profile.approve, and nobody decides their own request.
// =====================================================================

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('what can be requested', () => {
  test('identity, licence and qualification fields — and nothing HR owns', () => {
    for (const k of ['firstName', 'lastName', 'dateOfBirth', 'gender', 'idNumber', 'licenseNumber', 'licenseExpiry', 'qualification']) {
      assert.ok(REQUESTABLE[k], `${k} should be requestable`);
    }
    for (const k of ['email', 'role', 'position', 'department', 'employmentStatus', 'dateJoined', 'reportsToId', 'isActive', 'permissions']) {
      assert.equal(REQUESTABLE[k], undefined, `${k} must not be requestable`);
    }
  });
  test('an unknown field is refused', () => {
    assert.deepEqual(validateRequest('email', 'x@y.com'), { ok: false, error: 'FIELD_NOT_REQUESTABLE' });
    assert.deepEqual(validateRequest('role', 'admin'), { ok: false, error: 'FIELD_NOT_REQUESTABLE' });
  });
  test('a name cannot be emptied', () => {
    assert.equal(validateRequest('lastName', '').error, 'VALUE_REQUIRED');
    assert.equal(validateRequest('firstName', '   ').error, 'VALUE_REQUIRED');
  });
  test('dates must be real dates', () => {
    assert.equal(validateRequest('dateOfBirth', '1990-02-30').error, 'BAD_DATE');
    assert.equal(validateRequest('licenseExpiry', '31/12/2027').error, 'BAD_DATE');
    assert.deepEqual(validateRequest('licenseExpiry', '2027-12-31'), { ok: true, value: '2027-12-31' });
  });
  test('gender is one of the options; years is a whole number in range', () => {
    assert.equal(validateRequest('gender', 'Unknown').error, 'BAD_OPTION');
    assert.equal(validateRequest('yearsExperience', '2.5').error, 'BAD_NUMBER');
    assert.equal(validateRequest('yearsExperience', 90).error, 'BAD_NUMBER');
    assert.deepEqual(validateRequest('yearsExperience', 7), { ok: true, value: '7' });
  });
  test('text is trimmed and clipped; an optional field may be cleared', () => {
    assert.deepEqual(validateRequest('idNumber', '  12345678 '), { ok: true, value: '12345678' });
    assert.equal(validateRequest('specialty', 'x'.repeat(500)).value.length, 120);
    assert.deepEqual(validateRequest('specialty', ''), { ok: true, value: null });
  });
});

describe('contact — saved by the person directly', () => {
  test('phone, address, city and emergency contact; anything else is dropped', () => {
    const c = cleanContact({ phone: '+254 712 345 678', city: ' Nairobi ', email: 'new@x.com', position: 'Director' });
    assert.equal(c.ok, true);
    assert.deepEqual(c.user, { phone: '+254 712 345 678' });
    assert.deepEqual(c.profile, { city: 'Nairobi' });
  });
  test('a phone with letters is refused', () => {
    assert.equal(cleanContact({ phone: 'call me' }).error, 'BAD_PHONE');
  });
  test('emergency contact keeps name, relationship, phone only; empty clears it', () => {
    const c = cleanContact({ emergencyContact: { name: 'Asha', relationship: 'Sister', phone: '0700', extra: 'x' } });
    assert.deepEqual(c.profile.emergencyContact, { name: 'Asha', relationship: 'Sister', phone: '0700' });
    assert.equal(cleanContact({ emergencyContact: { name: '', phone: '' } }).profile.emergencyContact, null);
    assert.equal(cleanContact({ emergencyContact: 'Asha' }).error, 'BAD_EMERGENCY');
  });
  test('undefined leaves a field alone', () => {
    assert.deepEqual(cleanContact({}), { ok: true, user: {}, profile: {} });
  });
});

describe('current values compare the way they are stored', () => {
  test('a date column that arrives as a Date compares as YYYY-MM-DD', () => {
    assert.equal(normalise('dateOfBirth', new Date('1988-05-04T00:00:00Z')), '1988-05-04');
    assert.equal(currentValue('dateOfBirth', {}, { dateOfBirth: new Date('1988-05-04T00:00:00Z') }), '1988-05-04');
  });
  test('names come from the user row, the rest from the staff profile', () => {
    assert.equal(currentValue('lastName', { lastName: 'Wanjiru' }, { lastName: 'wrong' }), 'Wanjiru');
    assert.equal(currentValue('idNumber', { idNumber: 'wrong' }, { idNumber: '123' }), '123');
    assert.equal(currentValue('yearsExperience', {}, { yearsExperience: 7 }), '7');
    assert.equal(currentValue('specialty', {}, { specialty: '' }), null);
  });
});

describe('the to-do list', () => {
  test('expired before expiring before waiting', () => {
    const items = todoItems({
      licence: { licenceExpiresInDays: 20 },
      documents: [{ id: 1, category: 'BLS certificate', expiresInDays: -3 }],
      leave: [{ id: 9, status: 'Pending', typeName: 'Annual', startDate: '2026-10-05', owed: false }],
      pendingChanges: 2,
    });
    assert.deepEqual(items.map((i) => i.kind), ['document', 'licence', 'leave', 'change']);
    assert.match(items[0].text, /has expired/);
    assert.match(items[1].text, /expires in 20 days/);
    assert.equal(items[2].link, '/hr/me/leave?open=9');
    assert.match(items[3].text, /2 changes/);
  });
  test('a licence more than 60 days out is not on the list', () => {
    assert.deepEqual(todoItems({ licence: { licenceExpiresInDays: 61 } }), []);
    assert.deepEqual(todoItems({ licence: { licenceExpiresInDays: null } }), []);
  });
  test('a question from an approver and an owed document come first among leave', () => {
    const items = todoItems({ leave: [
      { id: 1, status: 'Pending', typeName: 'Annual', startDate: '2026-10-05', owed: false },
      { id: 2, status: 'InfoRequested', typeName: 'Annual', startDate: '2026-11-01', owed: false },
      { id: 3, status: 'Pending', typeName: 'Sick', startDate: '2026-09-20', owed: true },
    ] });
    assert.deepEqual(items.map((i) => i.link), ['/hr/me/leave?open=2', '/hr/me/leave?open=3', '/hr/me/leave?open=1']);
  });
  test('an item never names the reason for leave', () => {
    const items = todoItems({ leave: [{ id: 3, status: 'Pending', typeName: 'Sick', startDate: '2026-09-20', owed: true }] });
    assert.doesNotMatch(items[0].text, /Sick/);
  });
});

describe('the self view carries no access internals', () => {
  test('permissions and password dates are stripped', () => {
    for (const k of ['permissions', 'deniedPermissions', 'effectivePermissions', 'isTrueAdmin', 'passwordChangedAt']) {
      assert.ok(ACCESS_KEYS.includes(k), `${k} should be stripped`);
    }
  });
});

describe('the capability', () => {
  test('hr.profile.approve exists and admin access covers it', () => {
    assert.equal(PERMISSIONS.HR_PROFILE_APPROVE, 'hr.profile.approve');
    assert.ok(ADMIN_ACCESS_COVERS.includes('hr.profile.approve'));
  });
  test('the decision has an alert event', () => {
    assert.ok(ALERT_EVENTS.includes('change_request_decided'));
  });
});

describe('route gates', () => {
  const self = read('routes', 'hrSelf.js');
  const hr = read('routes', 'hr.js');

  test('My profile routes are open to every staff role and hr.self', () => {
    for (const [verb, p] of [['get', "'/'"], ['patch', "'/contact'"], ['get', "'/change-requests'"], ['post', "'/change-requests'"], ['post', "'/change-requests/:id/withdraw'"]]) {
      const re = new RegExp(`router\\.${verb}\\(${p.replace(/[/:]/g, (c) => `\\${c}`)}, authenticate, authorize\\(\\.\\.\\.SELF\\)`);
      assert.match(self, re, `${verb.toUpperCase()} ${p}`);
    }
  });
  test('deciding and listing change requests is hr.profile.approve', () => {
    assert.match(hr, /const PROFILE_APPROVE = \['admin', 'hr\.profile\.approve'\]/);
    assert.match(hr, /router\.get\('\/change-requests', authenticate, authorize\(\.\.\.PROFILE_APPROVE\)/);
    assert.match(hr, /router\.get\('\/change-requests\/count', authenticate, authorize\(\.\.\.PROFILE_APPROVE\)/);
    assert.match(hr, /router\.patch\('\/change-requests\/:id', authenticate, authorize\(\.\.\.PROFILE_APPROVE\)/);
  });
  test('a change request\'s attachment opens only for hr.profile.approve (added 2 Oct 2026)', () => {
    assert.match(hr, /router\.get\('\/change-requests\/:id\/attachment', authenticate, authorize\(\.\.\.PROFILE_APPROVE\)/);
    assert.doesNotMatch(self, /change-requests\/:id\/attachment/);
  });
});

describe('controller rules', () => {
  const src = read('controllers', 'hrProfileController.js');
  test('nobody decides a change to their own record', () => {
    assert.match(src, /row\.UserId === req\.user\.id\) return error\(res, [^)]*403, \{ code: 'OWN_REQUEST' \}/);
  });
  test('the badge does not count my own requests', () => {
    assert.match(src, /status: 'pending', UserId: \{ \[Op\.ne\]: req\.user\.id \}/);
  });
  test('a rejection needs a note; a request needs a reason', () => {
    assert.match(src, /decision === 'reject' && !note\) return error\(res, [^)]*400, \{ code: 'NOTE_REQUIRED' \}/);
    assert.match(src, /if \(!reason\) return error\(res, [^)]*400, \{ code: 'REASON_REQUIRED' \}/);
  });
  test('an approval is logged against the approver, naming the request', () => {
    assert.match(src, /editedBy: req\.user\.id/);
    assert.match(src, /\(change request #\$\{row\.id\}\)/);
  });
  test('the person is only ever looked up from the token', () => {
    assert.match(src, /loadMine\(req\.user\.id\)/);
    assert.doesNotMatch(src, /req\.body\??\.userId|req\.params\.userId/);
  });
  test('the decision notification carries no values or note', () => {
    const block = src.slice(src.indexOf("hrNotify.notify('change_request_decided'"));
    const call = block.slice(0, block.indexOf('});'));
    assert.doesNotMatch(call, /newValue|oldValue|note|reason/);
  });
});
