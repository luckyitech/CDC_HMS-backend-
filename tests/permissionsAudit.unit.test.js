// Permissions audit, 16 Oct 2026 — the policy facts the audit changed, pinned
// down against the pure gate so a route edit cannot quietly undo them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  gateResult, defaultStaffType, typeDefaultPermissions, hasPermission, canOpenPortal,
  STAFF_TYPES, PERMISSIONS, INTERNAL_ROLES,
} = require('../constants/permissions');

const u = (role, o = {}) => ({ id: 9, role, staffType: STAFF_TYPES.CLINICAL, permissions: [], deniedPermissions: [], ...o });
const INPATIENT_READ = ['doctor', 'nurse', 'admin', 'inpatient.access', 'portal.inpatient'];
const INPATIENT_ACT = ['doctor', 'nurse', 'admin', 'inpatient.write'];
const SCAN_READ = ['doctor', 'nurse', 'admin', PERMISSIONS.CLINICAL_VIEW];

test('a new front-desk account starts non-clinical, with no clinical bundle', () => {
  assert.equal(defaultStaffType('staff'), STAFF_TYPES.NON_CLINICAL);
  assert.equal(defaultStaffType('doctor'), STAFF_TYPES.CLINICAL);
  assert.equal(defaultStaffType('nurse'), STAFF_TYPES.CLINICAL);
  assert.equal(defaultStaffType('lab'), STAFF_TYPES.CLINICAL);
  const reception = u('staff', { staffType: STAFF_TYPES.NON_CLINICAL });
  assert.deepEqual(typeDefaultPermissions(reception), []);
  assert.equal(hasPermission(reception, PERMISSIONS.CLINICAL_VIEW), false);
});

test('inpatient follows the Inpatient workspace grant, not the staff role', () => {
  const reception = u('staff', { staffType: STAFF_TYPES.NON_CLINICAL });
  assert.equal(gateResult(reception, INPATIENT_READ), 'no', 'reception with nothing ticked sees no admissions');
  assert.equal(gateResult(reception, INPATIENT_ACT), 'no');
  const withWorkspace = u('staff', { permissions: [PERMISSIONS.PORTAL_INPATIENT] });
  assert.equal(gateResult(withWorkspace, INPATIENT_READ), 'ok', 'the workspace opens the board and the list');
  assert.equal(gateResult(withWorkspace, INPATIENT_ACT), 'no', 'acting still needs inpatient.write');
  const canAct = u('staff', { permissions: [PERMISSIONS.PORTAL_INPATIENT, PERMISSIONS.INPATIENT_WRITE] });
  assert.equal(gateResult(canAct, INPATIENT_ACT), 'ok');
  assert.equal(gateResult(u('doctor'), INPATIENT_READ), 'ok');
  assert.equal(gateResult(u('nurse'), INPATIENT_ACT), 'ok');
  const doctorWithdrawn = u('doctor', { deniedPermissions: [PERMISSIONS.PORTAL_INPATIENT] });
  assert.equal(gateResult(doctorWithdrawn, INPATIENT_READ), 'denied', 'withdrawing the workspace from a doctor closes the ward');
  assert.equal(canOpenPortal(doctorWithdrawn, PERMISSIONS.PORTAL_INPATIENT), false);
});

test('no inpatient route admits the staff role by name any more', () => {
  const dir = path.join(__dirname, '..', 'routes');
  for (const f of ['admissions.js', 'beds.js', 'wards.js', 'inpatientBilling.js', 'dischargeSummaries.js', 'inpatientObservations.js', 'mar.js', 'fluidBalance.js', 'wardRoundNotes.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/'staff'/.test(src), `${f} still names 'staff'`);
  }
});

test('scans follow the clinical record: clinical.view reads, non-clinical does not', () => {
  assert.equal(gateResult(u('staff', { staffType: STAFF_TYPES.CLINICAL }), SCAN_READ), 'ok');
  assert.equal(gateResult(u('staff', { staffType: STAFF_TYPES.NON_CLINICAL }), SCAN_READ), 'no');
  assert.equal(gateResult(u('lab'), SCAN_READ), 'ok', 'the lab is clinical and reads the record');
});

test('GET /patients/:uhid is gated: internal roles and the patient role, nobody else', () => {
  const gate = [...INTERNAL_ROLES, 'patient'];
  assert.equal(gateResult(u('patient', { staffType: undefined }), gate), 'ok', 'the controller then limits a patient to their own record');
  assert.equal(gateResult(u('staff'), gate), 'ok');
  assert.equal(gateResult(null, gate), 'no');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'patients.js'), 'utf8');
  assert.match(src, /router\.get\('\/:uhid', authenticate, authorize\(\.\.\.CLINICAL_READ_ROLES, 'patient'\), findPatient, ownRecordOrInternal/);
});
