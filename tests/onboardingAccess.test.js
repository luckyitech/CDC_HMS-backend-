const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PERMISSIONS, STAFF_TYPES } = require('../constants/permissions');
const { resolveAccessAtCreation } = require('../controllers/userController');

// =====================================================================
// Access at creation — the onboarding wizard's rules.
//
// Decision of record (Emu, 24 Sep 2026, claude/onboarding-wizard-build-spec.md):
//   1. no access section  -> unchanged: clinical, no grants
//   2. a preset applied UNCHANGED -> anyone who passed users.write
//   3. anything else      -> permissions.grant (or the true admin)
//   4. permissions.grant requested -> a key-holder only (never self: the
//      target does not exist yet)
// No database: the preset row is passed in as a plain object.
// =====================================================================

const user = (role, permissions = [], id = 1) => ({ id, role, permissions, deniedPermissions: [] });
const writer    = user('staff', [PERMISSIONS.USERS_WRITE]);
const adminAcc  = user('doctor', [PERMISSIONS.ADMIN_ACCESS]);
const keyHolder = user('doctor', [PERMISSIONS.PERMISSIONS_GRANT]);
const trueAdmin = user('admin');

const nursePreset = {
  id: 7, name: 'Nurse — clinic floor', status: 'active', baseRole: 'nurse', staffType: STAFF_TYPES.CLINICAL,
  permissions: [PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.MAR_ADMINISTER],
  deniedPermissions: [],
};

const resolve = (body, caller, preset = null, role = 'nurse') =>
  resolveAccessAtCreation({ body, role, caller, preset });

describe('rule 1 — no access section means nothing changes', () => {
  test('the legacy forms get clinical + no grants, for any caller', () => {
    for (const caller of [writer, adminAcc, keyHolder, trueAdmin]) {
      const { access, message } = resolve({ firstName: 'A' }, caller);
      assert.equal(message, undefined);
      assert.deepEqual(access.permissions, []);
      assert.deepEqual(access.deniedPermissions, []);
      assert.equal(access.staffType, STAFF_TYPES.CLINICAL);
      assert.equal(access.presetName, null);
      assert.equal(access.applied, false);
    }
  });

  test('empty strings and nulls count as "not sent"', () => {
    const { access } = resolve({ staffType: '', presetId: null }, writer);
    assert.equal(access.applied, false);
  });
});

describe('rule 2 — a preset applied unchanged needs only users.write', () => {
  test('presetId alone: the preset fills everything in', () => {
    const { access, message } = resolve({ presetId: 7 }, writer, nursePreset);
    assert.equal(message, undefined);
    assert.equal(access.staffType, STAFF_TYPES.CLINICAL);
    assert.ok(access.permissions.includes(PERMISSIONS.MAR_ADMINISTER));
    assert.ok(access.permissions.includes(PERMISSIONS.PORTAL_INPATIENT));
    assert.equal(access.presetName, 'Nurse — clinic floor');
    assert.equal(access.applied, true);
  });

  test('sending the preset\'s own lists back, in any order, is still "unchanged"', () => {
    const body = {
      presetId: 7, staffType: STAFF_TYPES.CLINICAL,
      permissions: [PERMISSIONS.MAR_ADMINISTER, PERMISSIONS.PORTAL_INPATIENT], deniedPermissions: [],
    };
    assert.equal(resolve(body, writer, nursePreset).message, undefined);
    assert.equal(resolve(body, adminAcc, nursePreset).message, undefined);
  });

  test('an archived preset cannot be applied', () => {
    const r = resolve({ presetId: 7 }, keyHolder, { ...nursePreset, status: 'archived' });
    assert.equal(r.code, 400);
  });

  test('a preset for another cadre is refused', () => {
    const r = resolve({ presetId: 7 }, keyHolder, nursePreset, 'doctor');
    assert.equal(r.code, 400);
    assert.match(r.message, /nurse account/);
  });

  test('an unknown presetId is refused', () => {
    assert.equal(resolve({ presetId: 99 }, keyHolder, null).code, 400);
  });
});

describe('rule 3 — any change from the preset needs permissions.grant', () => {
  const extra = {
    presetId: 7,
    permissions: [PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.MAR_ADMINISTER, PERMISSIONS.STOCK_WRITE],
  };

  test('a users.write holder adding a tick is refused with 403', () => {
    const r = resolve(extra, writer, nursePreset);
    assert.equal(r.code, 403);
    assert.match(r.message, /permissions administrator/);
  });

  test('admin.access does not help — it is not the key', () => {
    assert.equal(resolve(extra, adminAcc, nursePreset).code, 403);
  });

  test('a users.write holder changing the staff type is refused', () => {
    assert.equal(resolve({ presetId: 7, staffType: STAFF_TYPES.NON_CLINICAL }, writer, nursePreset).code, 403);
  });

  test('a users.write holder withdrawing something is refused', () => {
    assert.equal(resolve({ presetId: 7, deniedPermissions: [PERMISSIONS.QUEUE_WRITE] }, writer, nursePreset).code, 403);
  });

  test('a users.write holder setting access with no preset is refused', () => {
    assert.equal(resolve({ permissions: [PERMISSIONS.STOCK_ACCESS] }, writer).code, 403);
    assert.equal(resolve({ staffType: STAFF_TYPES.NON_CLINICAL }, writer).code, 403);
  });

  test('a key-holder may do all of the above', () => {
    const r = resolve(extra, keyHolder, nursePreset);
    assert.equal(r.message, undefined);
    assert.ok(r.access.permissions.includes(PERMISSIONS.STOCK_WRITE));
    assert.ok(r.access.permissions.includes(PERMISSIONS.STOCK_ACCESS), 'write implies access');
    assert.equal(r.access.presetName, 'Nurse — clinic floor');
    assert.equal(resolve({ staffType: STAFF_TYPES.NON_CLINICAL }, keyHolder).access.staffType, STAFF_TYPES.NON_CLINICAL);
  });

  test('the true admin account may too (fallback holder)', () => {
    assert.equal(resolve(extra, trueAdmin, nursePreset).message, undefined);
  });

  test('a withdrawal beats a grant, and is reported', () => {
    const r = resolve({
      permissions: [PERMISSIONS.STOCK_ACCESS], deniedPermissions: [PERMISSIONS.STOCK_ACCESS],
    }, keyHolder);
    assert.ok(!r.access.permissions.includes(PERMISSIONS.STOCK_ACCESS));
    assert.ok(r.access.deniedPermissions.includes(PERMISSIONS.STOCK_ACCESS));
    assert.deepEqual(r.access.conflicting, [PERMISSIONS.STOCK_ACCESS]);
  });

  test('an invalid staffType is a 400, not a 403', () => {
    assert.equal(resolve({ staffType: 'sometimes' }, keyHolder).code, 400);
  });
});

describe('rule 4 — the key itself', () => {
  test('a users.write holder cannot hand out permissions.grant', () => {
    assert.equal(resolve({ permissions: [PERMISSIONS.PERMISSIONS_GRANT] }, writer).code, 403);
  });

  test('admin.access cannot either', () => {
    assert.equal(resolve({ permissions: [PERMISSIONS.PERMISSIONS_GRANT] }, adminAcc).code, 403);
  });

  test('a key-holder can give a new person the key', () => {
    const r = resolve({ permissions: [PERMISSIONS.PERMISSIONS_GRANT] }, keyHolder);
    assert.ok(r.access.permissions.includes(PERMISSIONS.PERMISSIONS_GRANT));
  });

  test('hr.confidential and admin.access follow the same gate', () => {
    for (const cap of [PERMISSIONS.HR_CONFIDENTIAL, PERMISSIONS.ADMIN_ACCESS]) {
      assert.equal(resolve({ permissions: [cap] }, writer).code, 403, cap);
      assert.ok(resolve({ permissions: [cap] }, keyHolder).access.permissions.includes(cap), cap);
    }
  });
});
