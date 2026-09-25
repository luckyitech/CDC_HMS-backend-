const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS, PRESET_EXCLUDED, PRESET_ROLES, ADMIN_ACCESS_COVERS, STAFF_TYPES,
  defaultPermissionsFor, reconcilePermissionLists, ROLE_DEFAULT_PORTALS,
} = require('../constants/permissions');
const { validatePresetPayload } = require('../controllers/permissionPresetController');

// =====================================================================
// Permission presets — what may go in one, and the shared helpers the
// onboarding wizard relies on. No database.
// =====================================================================

describe('PRESET_EXCLUDED — the three per-person-only capabilities', () => {
  test('is exactly admin.access, permissions.grant and hr.confidential', () => {
    assert.deepEqual([...PRESET_EXCLUDED].sort(), [
      PERMISSIONS.ADMIN_ACCESS, PERMISSIONS.HR_CONFIDENTIAL, PERMISSIONS.PERMISSIONS_GRANT,
    ].sort());
  });

  test('the two non-propagating capabilities are excluded from BOTH admin.access and presets', () => {
    for (const cap of [PERMISSIONS.PERMISSIONS_GRANT, PERMISSIONS.HR_CONFIDENTIAL]) {
      assert.ok(!ADMIN_ACCESS_COVERS.includes(cap), `${cap} in ADMIN_ACCESS_COVERS`);
      assert.ok(PRESET_EXCLUDED.includes(cap), `${cap} not in PRESET_EXCLUDED`);
    }
  });

  test('a payload carrying one is refused, naming it', () => {
    for (const cap of PRESET_EXCLUDED) {
      const r = validatePresetPayload({ name: 'X', baseRole: 'staff', permissions: [cap] });
      assert.ok(r.message, cap);
      assert.ok(r.message.includes(cap), r.message);
      const d = validatePresetPayload({ name: 'X', baseRole: 'staff', deniedPermissions: [cap] });
      assert.ok(d.message, `${cap} as a denial`);
    }
  });
});

describe('validatePresetPayload', () => {
  test('a good payload is normalised', () => {
    const r = validatePresetPayload({
      name: '  Pharmacy ', baseRole: 'staff', staffType: STAFF_TYPES.NON_CLINICAL,
      permissions: [PERMISSIONS.STOCK_WRITE], deniedPermissions: [], department: ' Pharmacy ',
    });
    assert.equal(r.message, undefined);
    assert.equal(r.fields.name, 'Pharmacy');
    assert.equal(r.fields.department, 'Pharmacy');
    assert.equal(r.fields.position, null);
    assert.ok(r.fields.permissions.includes(PERMISSIONS.STOCK_ACCESS), 'write implies access');
  });

  test('needs a name and a known cadre', () => {
    assert.ok(validatePresetPayload({ baseRole: 'staff' }).message);
    assert.ok(validatePresetPayload({ name: 'X', baseRole: 'admin' }).message, 'admin is not a preset cadre');
    assert.ok(validatePresetPayload({ name: 'X', baseRole: 'patient' }).message);
  });

  test('preset cadres are exactly the permissible roles', () => {
    assert.deepEqual([...PRESET_ROLES].sort(), ['doctor', 'lab', 'nurse', 'staff']);
  });

  test('staffType defaults to clinical and rejects nonsense', () => {
    assert.equal(validatePresetPayload({ name: 'X', baseRole: 'nurse' }).fields.staffType, STAFF_TYPES.CLINICAL);
    assert.ok(validatePresetPayload({ name: 'X', baseRole: 'nurse', staffType: 'part' }).message);
  });

  test('unknown capability names are dropped, not stored', () => {
    const r = validatePresetPayload({ name: 'X', baseRole: 'nurse', permissions: ['made.up'] });
    assert.deepEqual(r.fields.permissions, []);
  });

  test('a capability in both lists: the withdrawal wins', () => {
    const r = validatePresetPayload({
      name: 'X', baseRole: 'nurse',
      permissions: [PERMISSIONS.QUEUE_WRITE], deniedPermissions: [PERMISSIONS.QUEUE_WRITE],
    });
    assert.ok(!r.fields.permissions.includes(PERMISSIONS.QUEUE_WRITE));
    assert.ok(r.fields.deniedPermissions.includes(PERMISSIONS.QUEUE_WRITE));
  });
});

describe('defaultPermissionsFor — one baseline for the Staff File and the wizard', () => {
  test('a clinical nurse gets the role portals plus the clinical bundle', () => {
    const d = defaultPermissionsFor('nurse', STAFF_TYPES.CLINICAL);
    for (const p of ROLE_DEFAULT_PORTALS.nurse) assert.ok(d.includes(p), p);
    assert.ok(d.includes(PERMISSIONS.CLINICAL_RECORD));
  });

  test('a non-clinical receptionist gets portals only', () => {
    const d = defaultPermissionsFor('staff', STAFF_TYPES.NON_CLINICAL);
    for (const p of ROLE_DEFAULT_PORTALS.staff) assert.ok(d.includes(p), p);
    assert.ok(!d.includes(PERMISSIONS.CLINICAL_VIEW));
  });

  test('a clinical lab tech reads the record but does not carry the care bundle', () => {
    const d = defaultPermissionsFor('lab', STAFF_TYPES.CLINICAL);
    assert.ok(d.includes(PERMISSIONS.CLINICAL_VIEW));
    assert.ok(!d.includes(PERMISSIONS.CLINICAL_RECORD));
  });

  test('a patient, or a made-up role, has no baseline', () => {
    assert.deepEqual(defaultPermissionsFor('patient', STAFF_TYPES.CLINICAL), []);
    assert.deepEqual(defaultPermissionsFor('wizard', STAFF_TYPES.CLINICAL), []);
  });
});

describe('reconcilePermissionLists', () => {
  test('sanitises both sides and reports the overlap', () => {
    const r = reconcilePermissionLists(
      [PERMISSIONS.STOCK_WRITE, 'bogus.cap'],
      [PERMISSIONS.STOCK_WRITE],
    );
    assert.ok(r.granted.includes(PERMISSIONS.STOCK_ACCESS));
    assert.ok(!r.granted.includes(PERMISSIONS.STOCK_WRITE));
    assert.deepEqual(r.conflicting, [PERMISSIONS.STOCK_WRITE]);
  });

  test('non-arrays are treated as empty', () => {
    assert.deepEqual(reconcilePermissionLists(undefined, 'x'), { granted: [], denied: [], conflicting: [] });
  });
});
