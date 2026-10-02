const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PERMISSIONS, ADMIN_ACCESS_COVERS, PERMISSION_GROUPS, passesAdminGate, hasPermission } = require('../constants/permissions');
const { authorize } = require('../middleware/auth');
const { leaveViewOrSelf } = require('../routes/staff');
const { canDecideLeaveFor, canManageLeave, formatLeave } = require('../controllers/leaveController');
const { storedName, resolveStoredFile, STAFF_DOCUMENT_DIR, LEGACY_STAFF_DOCUMENT_DIR } = require('../utils/staffDocumentStorage');
const { normaliseAlerts, ALERT_EVENTS } = require('../utils/hrConfig');

// =====================================================================
// B27 phase 0 — HR leave foundation (28 Sep 2026). No database.
// Spec: claude/hr-leave-and-my-profile-build-spec.md.
// =====================================================================

const user = (role, permissions = [], deniedPermissions = [], id = 1) => ({ id, role, permissions, deniedPermissions });
const run = (middleware, req) => new Promise((resolve) => {
  const res = { code: 200 };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => resolve({ allowed: false, code: res.code, body: b });
  middleware(req, res, () => resolve({ allowed: true }));
});
const readRoute = (file) => fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');

describe('the leave and HR-settings capabilities (D8)', () => {
  test('each is covered by admin.access, and has its own card in the HR Suite group', () => {
    // HR Tier 3: the HR Suite is several groups, each marked `hr`.
    const hr = { areas: PERMISSION_GROUPS.filter((g) => g.hr).flatMap((g) => g.areas) };
    for (const cap of [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_MANAGE, PERMISSIONS.LEAVE_POLICY, PERMISSIONS.HR_SETTINGS]) {
      assert.ok(ADMIN_ACCESS_COVERS.includes(cap), cap);
      assert.ok(hr.areas.some((a) => a.access === cap), `${cap} needs a card`);
    }
  });
  test('leave.policy implies leave.manage', () => {
    assert.equal(hasPermission(user('staff', [PERMISSIONS.LEAVE_POLICY]), PERMISSIONS.LEAVE_MANAGE), true);
  });
  test('the hr.settings card warns that tag keys are secrets', () => {
    const area = PERMISSION_GROUPS.flatMap((g) => g.areas).find((a) => a.access === PERMISSIONS.HR_SETTINGS);
    assert.match(area.warning, /secret/i);
  });
  test('users.write and config.write no longer gate leave decisions, entitlement or HR settings', () => {
    const staff = readRoute('staff.js');
    // Phase 3 removed the staff-file decide route (deciding is /api/leave/requests/:id).
    const decideRoute = staff.match(/router\.patch\('\/:employeeId\/leaves\/:id'[^\n]*/);
    assert.ok(!decideRoute || !/users\.write/.test(decideRoute[0]));
    // The staff-file entitlement route was retired (2 Oct 2026) — overrides live on Leave settings only.
    assert.doesNotMatch(staff, /router\.put\('\/:employeeId\/leave-balances'/);
    assert.doesNotMatch(readRoute('hr.js'), /authorize\([^)]*config\.write/);
    assert.doesNotMatch(readRoute('hr.js'), /\[[^\]]*'config\.write'/);
  });
});

describe('who decides leave (canDecideLeaveFor)', () => {
  const colleague = { id: 42 };
  test('leave.manage decides anyone\'s; admin.access too', () => {
    assert.equal(canDecideLeaveFor(user('staff', [PERMISSIONS.LEAVE_MANAGE]), colleague), true);
    assert.equal(canDecideLeaveFor(user('doctor', [PERMISSIONS.ADMIN_ACCESS]), colleague), true);
  });
  test('leave.approve decides only a request it is listed on', () => {
    const approver = user('doctor', [PERMISSIONS.LEAVE_APPROVE]);
    assert.equal(canDecideLeaveFor(approver, colleague), false);
    assert.equal(canDecideLeaveFor(approver, colleague, { isListedApprover: true }), true);
  });
  test('being listed without leave.approve is not enough', () => {
    assert.equal(canDecideLeaveFor(user('nurse'), colleague, { isListedApprover: true }), false);
  });
  test('never your own, whatever you hold', () => {
    assert.equal(canDecideLeaveFor(user('admin', [], [], 42), colleague), false);
    assert.equal(canDecideLeaveFor(user('staff', [PERMISSIONS.LEAVE_MANAGE], [], 42), colleague, { isListedApprover: true }), false);
  });
  test('a withdrawal of leave.manage beats admin.access', () => {
    assert.equal(canManageLeave(user('doctor', [PERMISSIONS.ADMIN_ACCESS], [PERMISSIONS.LEAVE_MANAGE])), false);
  });
  test('the route gate admits leave.approve and leave.manage, refuses users.write alone', async () => {
    const gate = authorize('admin', 'leave.approve', 'leave.manage');
    assert.equal((await run(gate, { user: user('doctor', [PERMISSIONS.LEAVE_APPROVE]) })).allowed, true);
    assert.equal((await run(gate, { user: user('staff', [PERMISSIONS.LEAVE_POLICY]) })).allowed, true);   // implies manage
    assert.equal((await run(gate, { user: user('staff', [PERMISSIONS.USERS_WRITE]) })).allowed, false);
  });
});

describe('opening someone\'s leave tab (leaveViewOrSelf)', () => {
  const other = { id: 42 };
  test('self, users.view and leave.manage pass; anyone else is refused', async () => {
    assert.equal((await run(leaveViewOrSelf, { user: user('nurse', [], [], 42), staffUser: other })).allowed, true);
    assert.equal((await run(leaveViewOrSelf, { user: user('staff', [PERMISSIONS.USERS_VIEW]), staffUser: other })).allowed, true);
    assert.equal((await run(leaveViewOrSelf, { user: user('staff', [PERMISSIONS.LEAVE_MANAGE]), staffUser: other })).allowed, true);
    assert.equal((await run(leaveViewOrSelf, { user: user('nurse'), staffUser: other })).allowed, false);
  });
});

describe('sick leave is health data (spec §11)', () => {
  const sick = { id: 1, leaveType: 'Sick', days: '3.00', reason: 'flu', decisionNote: 'get well', status: 'Approved',
    charges: [{ leaveType: 'Sick', days: '3.00', status: 'active' }] };
  const annual = { id: 2, leaveType: 'Annual', days: '2.50', reason: 'family trip', status: 'Pending', charges: [] };

  test('redacted: sick shows as Private with no reason or note; other types keep the type but lose the reason', () => {
    const s = formatLeave(sick, { redact: true });
    assert.equal(s.leaveType, 'Private'); assert.equal(s.reason, null); assert.equal(s.decisionNote, null);
    assert.deepEqual(s.charges, [{ leaveType: 'Private', days: 3 }]);
    const a = formatLeave(annual, { redact: true });
    assert.equal(a.leaveType, 'Annual'); assert.equal(a.reason, null);
  });
  test('not redacted: everything shows, and days are numbers not "3.00" strings', () => {
    const s = formatLeave(sick);
    assert.equal(s.leaveType, 'Sick'); assert.equal(s.reason, 'flu'); assert.strictEqual(s.days, 3);
    assert.strictEqual(formatLeave(annual).days, 2.5);
  });
  test('approving a doctor\'s leave never writes the type onto the appointment book', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'leaveController.js'), 'utf8');
    assert.doesNotMatch(src, /reason:\s*`\$\{leave\.leaveType\}/);
  });
});

describe('the bell never broadcasts HR alerts', () => {
  const load = (flag) => {
    const key = require.resolve('../controllers/notificationController');
    delete require.cache[key];
    const before = process.env.NOTIFY_ALL_DOCTORS;
    process.env.NOTIFY_ALL_DOCTORS = flag;
    const mod = require('../controllers/notificationController');
    process.env.NOTIFY_ALL_DOCTORS = before;
    delete require.cache[key];
    return mod;
  };
  const { Op } = require('sequelize');

  test('flag off: own rows only', () => {
    assert.deepEqual(load('false').bellScope({ id: 7, role: 'doctor' }), { assignedDoctorId: 7 });
  });
  test('flag on: a doctor sees every DOCUMENT row but only their own others', () => {
    const scope = load('true').bellScope({ id: 7, role: 'doctor' });
    assert.deepEqual(scope[Op.or], [{ category: 'document' }, { assignedDoctorId: 7 }]);
  });
  test('flag on: a non-doctor still sees only their own', () => {
    assert.deepEqual(load('true').bellScope({ id: 9, role: 'staff' }), { assignedDoctorId: 9 });
  });
  test('the bell route is open to every internal role', () => {
    assert.match(readRoute('notifications.js'), /const BELL = \['doctor', 'staff', 'nurse', 'lab', 'admin'\]/);
  });
});

describe('staff documents live in private/ (weak point A5)', () => {
  test('the stored name survives a Windows path read on any machine', () => {
    assert.equal(storedName('C:\\Users\\Administrator\\Desktop\\CDC\\back_end\\uploads\\staff-documents\\ab12.pdf'), 'ab12.pdf');
    assert.equal(storedName('/srv/app/uploads/staff-documents/ab12.pdf'), 'ab12.pdf');
  });
  test('a tampered path cannot escape the folder', () => {
    assert.equal(resolveStoredFile('../../.env'), null);
    assert.equal(resolveStoredFile('..'), null);
    assert.equal(resolveStoredFile(''), null);
  });
  test('private first, legacy as a fallback, nothing else', () => {
    fs.mkdirSync(STAFF_DOCUMENT_DIR, { recursive: true });
    fs.mkdirSync(LEGACY_STAFF_DOCUMENT_DIR, { recursive: true });
    const name = `b27-test-${process.pid}.pdf`;
    const legacy = path.join(LEGACY_STAFF_DOCUMENT_DIR, name);
    const priv = path.join(STAFF_DOCUMENT_DIR, name);
    try {
      fs.writeFileSync(legacy, 'x');
      assert.equal(resolveStoredFile(`C:\\old\\${name}`), legacy);
      fs.writeFileSync(priv, 'x');
      assert.equal(resolveStoredFile(`C:\\old\\${name}`), priv);
    } finally {
      fs.rmSync(legacy, { force: true });
      fs.rmSync(priv, { force: true });
    }
  });
  test('the uploader writes to private/, and app.js refuses the old public path', () => {
    const mw = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'uploadStaffDocument.js'), 'utf8');
    assert.match(mw, /ensureStaffDocumentDir/);
    assert.doesNotMatch(mw, /'uploads', 'staff-documents'/);
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const block = app.indexOf("app.use('/uploads/staff-documents'");
    const serve = app.indexOf("app.use('/uploads', express.static");
    assert.ok(block > -1 && block < serve, 'the block must be mounted BEFORE the static /uploads handler');
  });
  test('no static mount serves private/', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.doesNotMatch(app, /express\.static\([^)]*private/);
  });
});

describe('HR alert channels (D9)', () => {
  test('every event defaults to bell + email, WhatsApp off', () => {
    const a = normaliseAlerts(null);
    for (const e of ALERT_EVENTS) assert.deepEqual(a[e], { bell: true, email: true, whatsapp: false }, e);
  });
  test('a partial setting keeps the defaults for the rest; junk is ignored', () => {
    const a = normaliseAlerts(JSON.stringify({ leave_decided: { email: false, bell: 'yes' } }));
    assert.deepEqual(a.leave_decided, { bell: true, email: false, whatsapp: false });
    assert.deepEqual(normaliseAlerts('not json').expiry_hr, { bell: true, email: true, whatsapp: false });
  });
});

describe('admin.access passes every new gate (Emu runs on admin.access)', () => {
  test('passesAdminGate for each', () => {
    const emu = user('doctor', [PERMISSIONS.ADMIN_ACCESS]);
    for (const cap of [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_MANAGE, PERMISSIONS.LEAVE_POLICY, PERMISSIONS.HR_SETTINGS]) {
      assert.equal(passesAdminGate(emu, cap), true, cap);
    }
  });
});
