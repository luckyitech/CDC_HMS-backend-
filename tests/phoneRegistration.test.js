const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

const db = require('../models');
const auth = require('../controllers/authController');
const hrDevices = require('../controllers/hrDevicesController');
const hrAttendance = require('../controllers/hrAttendanceController');
const { authenticate } = require('../middleware/auth');
const { canRegisterPhones } = require('../constants/permissions');
const { hrGrantRefusal, presetApplyRefusal } = require('../utils/hrGrant');
const { setSigninSecurityConfig, clearSigninSecurityCache, getSigninSecurityConfig } = require('../utils/signinSecurityConfig');

// =====================================================================
// Check-in phones registered by HR (17 Oct 2026, Emu) — real database, like
// tests/signinTracking.test.js. "Only HR with the register phones permission
// can register a phone", and a registered phone is never a way into the HMS.
// Every fixture is tagged and removed.
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run phone registration tests against production.');
}

const TAG = 'phonereg-test';
const PASSWORD = 'Correct-horse-1';
const UA_PHONE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const CLINIC_IP = '197.248.95.40';
const HOME_IP = '41.90.70.10';
const users = {};

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const req = ({ user, body = {}, ip = CLINIC_IP } = {}) => ({
  user, body, params: {}, query: {}, ip, socket: {}, headers: { 'user-agent': UA_PHONE },
});
const run = async (fn, opts) => { const r = res(); await fn(req(opts), r); return r; };
const asUser = (u, extra = {}) => ({ id: u.id, role: u.role, firstName: u.firstName, lastName: u.lastName,
  permissions: u.permissions || [], deniedPermissions: u.deniedPermissions || [], ...extra });
const mkUser = async (key, role, permissions = [], extra = {}) => {
  users[key] = await db.User.create({
    firstName: 'Phone', lastName: `${key} ${TAG}`, email: `${key}.${TAG}@example.test`,
    password: await bcrypt.hash(PASSWORD, 4), role, isActive: true, permissions, ...extra,
  });
  return users[key];
};
const issue = (registrar, target) => run(hrDevices.issueRegistration, { user: asUser(registrar), body: { userId: target.id } });
const redeem = (code) => run(auth.registerDevice, { body: { code } });
const passFor = async (deviceToken, ip = CLINIC_IP) => run(auth.deviceSession, { body: { deviceToken }, ip });
// authenticate() for a method + path, as the router would see it.
const through = async (token, method, path, ip = CLINIC_IP) => {
  const r = res(); let passed = false;
  await authenticate({ method, headers: { authorization: `Bearer ${token}` }, originalUrl: path, ip, socket: {} }, r, () => { passed = true; });
  return { passed, r };
};
const tapAs = (user) => run(hrAttendance.tap, { user, body: { uid: '04FFFFFFFFFFFF', ctr: '000001', cmac: '0000000000000000' } });

before(async () => {
  await db.sequelize.authenticate();
  await mkUser('nurse', 'nurse');
  await mkUser('registrar', 'staff', ['hr.devices.register']);
  await mkUser('broadadmin', 'doctor', ['admin.access']);
  await mkUser('withdrawn', 'doctor', ['hr.devices.register'], { deniedPermissions: ['hr.devices.register'] });
  await mkUser('patient', 'patient');
  await mkUser('gone', 'staff', [], { isActive: false });
  await setSigninSecurityConfig({ networks: [{ value: '197.248.95.0/24', label: 'Main line' }], lockOutside: false, gpsMode: 'off' });
});

after(async () => {
  const ids = Object.values(users).map((u) => u.id);
  await db.StaffAttendance.destroy({ where: { UserId: ids } });
  await db.PhoneRegistration.destroy({ where: { UserId: ids } });
  await db.UserDevice.destroy({ where: { UserId: ids } });
  await db.UserLoginLog.destroy({ where: { userId: ids } });
  await db.Notification.destroy({ where: { assignedDoctorId: ids } });
  await db.Setting.destroy({ where: { key: { [Op.like]: 'security.signin.%' } } });
  await db.User.destroy({ where: { id: ids } });
  clearSigninSecurityCache();
  await db.sequelize.close();
});

describe('who may register a phone', () => {
  test('an explicit grant or the main admin account — not admin.access, not by role', () => {
    assert.equal(canRegisterPhones(asUser(users.registrar)), true);
    assert.equal(canRegisterPhones({ id: 1, role: 'admin', permissions: [], deniedPermissions: [] }), true);
    assert.equal(canRegisterPhones(asUser(users.nurse)), false);
    assert.equal(canRegisterPhones(asUser(users.broadadmin)), false, 'full administrator access does not carry it');
    assert.equal(canRegisterPhones(asUser(users.withdrawn)), false, 'a withdrawal wins over the grant');
  });

  test('an HR grantor can pass it on only if they hold it themselves — admin.access is not enough', () => {
    const target = { id: 999001, role: 'staff', permissions: [], deniedPermissions: [] };
    const before = { permissions: [], deniedPermissions: [], staffType: 'non_clinical' };
    const after = { ...before, permissions: ['hr.devices.register'] };
    const broadGrantor = { id: 999002, role: 'doctor', permissions: ['hr.grant', 'admin.access'], deniedPermissions: [] };
    const holder = { id: 999003, role: 'doctor', permissions: ['hr.grant', 'hr.devices.register'], deniedPermissions: [] };
    assert.equal(hrGrantRefusal({ caller: broadGrantor, target, before, after })?.extra?.code, 'NOT_HELD');
    assert.equal(hrGrantRefusal({ caller: holder, target, before, after }), null);
    assert.equal(presetApplyRefusal({ caller: broadGrantor, granted: ['hr.devices.register'] })?.extra?.code, 'PRESET_NOT_HELD');
  });

  test('signing in never remembers a phone any more', async () => {
    const r = await run(auth.login, { body: { email: users.nurse.email, password: PASSWORD, rememberDevice: true, context: 'hr-tap' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.data.deviceToken, undefined);
    assert.equal(await db.UserDevice.count({ where: { UserId: users.nurse.id } }), 0);
  });

  test('codes are only for active staff accounts', async () => {
    assert.equal((await issue(users.registrar, users.patient)).statusCode, 404);
    assert.equal((await issue(users.registrar, users.gone)).statusCode, 409);
  });
});

describe('registering with a one-time code', () => {
  let firstToken;

  test('a code works once; a newer code ends the older; typing is forgiving', async () => {
    const old = await issue(users.registrar, users.nurse);
    assert.equal(old.statusCode, 200);
    assert.match(old.body.data.code, /^[A-HJ-NP-Z2-9]{8}$/);
    const fresh = await issue(users.registrar, users.nurse);
    assert.equal((await redeem(old.body.data.code)).statusCode, 400, 'the older code stopped working');

    const code = fresh.body.data.code;
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
    const r = await redeem(typed);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    firstToken = r.body.data.deviceToken;
    assert.ok(firstToken.length >= 40);
    assert.equal((await redeem(code)).statusCode, 400, 'used once');

    const device = await db.UserDevice.findOne({ where: { UserId: users.nurse.id, revokedAt: null } });
    assert.equal(device.registeredById, users.registrar.id);
    assert.equal(device.label, 'Android · Chrome');
  });

  test('the person and HR are told', async () => {
    const mine = await db.Notification.findOne({ where: { assignedDoctorId: users.nurse.id, type: 'phone_registered' } });
    assert.ok(mine);
    assert.match(mine.body, /registered by Phone registrar/);
    const hr = await db.Notification.findOne({ where: { assignedDoctorId: users.registrar.id, type: 'phone_registered' } });
    assert.ok(hr);
    assert.match(hr.title, /Phone nurse/);
  });

  test('an expired code is refused', async () => {
    const r = await issue(users.registrar, users.nurse);
    await db.PhoneRegistration.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { UserId: users.nurse.id, usedAt: null } });
    assert.equal((await redeem(r.body.data.code)).statusCode, 400);
    assert.equal((await redeem('NOTACODE')).statusCode, 400);
  });

  test('the phone gets a check-in-only pass, never a session', async () => {
    const r = await passFor(firstToken);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.user, undefined, 'no profile, no portals');
    const claims = jwt.decode(r.body.data.token);
    assert.equal(claims.scope, 'tap');
    assert.equal(claims.exp - claims.iat, 15 * 60);

    const refused = await through(r.body.data.token, 'GET', '/api/queue');
    assert.equal(refused.passed, false);
    assert.equal(refused.r.statusCode, 403);
    assert.equal(refused.r.body.code, 'TAP_ONLY');
    assert.equal((await through(r.body.data.token, 'GET', '/api/hr/attendance/me')).passed, false);
    assert.equal((await through(r.body.data.token, 'POST', '/api/hr/attendance/tap')).passed, true);
    assert.equal((await through(r.body.data.token, 'GET', '/api/hr/attendance/checkin-config')).passed, true);
  });

  test('only the registered phone checks in — not a password session', async () => {
    const pass = jwt.decode((await passFor(firstToken)).body.data.token);
    const viaPhone = await tapAs(asUser(users.nurse, { scope: 'tap', deviceId: pass.deviceId }));
    assert.equal(viaPhone.statusCode, 200, 'past the phone check (an unknown tag is then refused as usual)');
    assert.equal(viaPhone.body.data.reason, 'unknown_tag');

    const viaPassword = await tapAs(asUser(users.nurse));
    assert.equal(viaPassword.statusCode, 403);
    assert.equal(viaPassword.body.code, 'PHONE_NOT_REGISTERED');
    const oldStyle = await tapAs(asUser(users.nurse, { deviceId: pass.deviceId }));
    assert.equal(oldStyle.statusCode, 403, 'a full session carrying a device id is not a pass');
    const someoneElse = await tapAs(asUser(users.registrar, { scope: 'tap', deviceId: pass.deviceId }));
    assert.equal(someoneElse.statusCode, 403, "another person's phone");
  });

  test('one phone per person: registering a new one ends the old', async () => {
    const oldPass = jwt.decode((await passFor(firstToken)).body.data.token);
    const code = (await issue(users.registrar, users.nurse)).body.data.code;
    const second = await redeem(code);
    assert.equal(second.statusCode, 200);
    assert.equal(await db.UserDevice.count({ where: { UserId: users.nurse.id, revokedAt: null } }), 1);
    assert.equal((await passFor(firstToken)).statusCode, 401, 'the old phone is no longer registered');
    const stale = await tapAs(asUser(users.nurse, { scope: 'tap', deviceId: oldPass.deviceId }));
    assert.equal(stale.statusCode, 403, 'a pass issued before the swap stops at the next tap');
    assert.equal((await passFor(second.body.data.deviceToken)).statusCode, 200);
    const replaced = await db.Notification.findOne({ where: { assignedDoctorId: users.nurse.id, type: 'phone_registered' }, order: [['id', 'DESC']] });
    assert.match(replaced.body, /previous phone no longer checks you in/);
  });

  test('HR sees who registered the phone', async () => {
    const r = await run(hrDevices.list, { user: asUser(users.registrar) });
    // own list (registrar has none) …
    assert.deepEqual(r.body.data, []);
    const q = res();
    await hrDevices.list({ user: asUser(users.registrar), query: { userId: String(users.nurse.id) } }, q);
    assert.equal(q.statusCode, 200);
    assert.equal(q.body.data.length, 1);
    assert.equal(q.body.data[0].registeredBy, `Phone registrar ${TAG}`);
  });
});

describe('the network lock and the entrance tag', () => {
  test('entrance-tag phones are exempt by default, and the pass still opens nothing else', async () => {
    const cfg0 = await getSigninSecurityConfig();
    assert.equal(cfg0.lockTapExempt, true);
    await setSigninSecurityConfig({ lockOutside: true });
    const device = await db.UserDevice.findOne({ where: { UserId: users.nurse.id, revokedAt: null } });
    const code = (await issue(users.registrar, users.nurse)).body.data.code;
    const token = (await redeem(code)).body.data.deviceToken;
    const r = await passFor(token, HOME_IP);
    assert.equal(r.statusCode, 200, 'a phone on mobile data at the door still checks in');
    assert.equal((await through(r.body.data.token, 'POST', '/api/hr/attendance/tap', HOME_IP)).passed, true);
    assert.equal((await through(r.body.data.token, 'GET', '/api/queue', HOME_IP)).passed, false);
    const login = await run(auth.login, { body: { email: users.nurse.email, password: PASSWORD }, ip: HOME_IP });
    assert.equal(login.statusCode, 423, 'the same person signing in to the HMS from outside is still refused');
    assert.ok(device);
    await setSigninSecurityConfig({ lockOutside: false });
  });
});
