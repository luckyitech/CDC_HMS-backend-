const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

const db = require('../models');
const auth = require('../controllers/authController');
const signins = require('../controllers/signinController');
const activity = require('../controllers/activityController');
const { enrich } = require('../services/signinLog');
const { setSigninSecurityConfig, clearSigninSecurityCache } = require('../utils/signinSecurityConfig');
const { authenticate } = require('../middleware/auth');

// =====================================================================
// Sign-in tracking (16 Oct 2026, Emu) — real database, like
// tests/invoiceReceive.test.js. The controllers are called directly; the
// lookup service is a stubbed fetch. Every fixture is tagged and removed.
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run sign-in tests against production.');
}

const TAG = 'signin-test';
const PASSWORD = 'Correct-horse-1';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const users = {};
const realFetch = global.fetch;
let fetchCalls = 0;

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const asUser = (u, extra = {}) => ({ id: u.id, role: u.role, firstName: u.firstName, lastName: u.lastName,
  permissions: u.permissions || [], deniedPermissions: u.deniedPermissions || [], ...extra });
const loginAs = async (email, password, { ip = '41.90.70.10:51000', ua = UA_MAC } = {}) => {
  const r = res();
  await auth.login({ body: { email, password }, ip, headers: { 'user-agent': ua }, socket: {} }, r);
  return r;
};
const latestFor = (where) => db.UserLoginLog.findOne({ where, order: [['id', 'DESC']] });
// The background run (setImmediate) and this explicit one may race; the flag
// is claimed atomically, so wait for whichever run claimed it to finish.
const settle = async (row) => {
  await enrich(row.id);
  for (let i = 0; i < 40; i++) {
    const now = await db.UserLoginLog.findByPk(row.id);
    if (!now.flagged || now.alertedAt) return now;
    await new Promise((r) => setTimeout(r, 50));
  }
  return db.UserLoginLog.findByPk(row.id);
};
const mkUser = async (key, role, permissions = [], extra = {}) => {
  users[key] = await db.User.create({
    firstName: 'Signin', lastName: `${key} ${TAG}`, email: `${key}.${TAG}@example.test`,
    password: await bcrypt.hash(PASSWORD, 4), role, isActive: true, permissions, ...extra,
  });
  return users[key];
};

before(async () => {
  await db.sequelize.authenticate();
  await mkUser('nurse', 'nurse');
  await mkUser('watcher', 'doctor', ['it.signins.alerts']);
  await mkUser('broadadmin', 'doctor', ['admin.access']);
  await mkUser('patient', 'patient');
  await mkUser('gone', 'staff', [], { isActive: false });
  await mkUser('remote', 'doctor', ['it.remote.signin']);
  await setSigninSecurityConfig({
    networks: [{ value: '197.248.95.0/24', label: 'Main line' }],
    lookupEnabled: true, lookupProvider: 'ipapi', gpsMode: 'off', lockOutside: false,
    alertsEnabled: true, alertChannels: { bell: true, email: false },
    rules: { newDevice: true, newCountry: true, outsideClinic: false, failedAttempts: true, failedCount: 3, failedWindowMinutes: 15, outsideHours: false },
  });
  global.fetch = async (url) => {
    fetchCalls += 1;
    const ip = String(url).split('/')[3];
    const place = ip.startsWith('41.')
      ? { city: 'Mombasa', region: 'Mombasa', country_code: 'KE', country_name: 'Kenya', org: 'Safaricom Limited' }
      : { city: 'Dar es Salaam', region: 'Dar es Salaam', country_code: 'TZ', country_name: 'Tanzania', org: 'Vodacom' };
    return { ok: true, json: async () => place };
  };
});

after(async () => {
  global.fetch = realFetch;
  const ids = Object.values(users).map((u) => u.id);
  await db.UserLoginLog.destroy({ where: { [Op.or]: [{ userId: ids }, { emailTried: { [Op.like]: `%${TAG}%` } }] } });
  await db.Notification.destroy({ where: { assignedDoctorId: ids } });
  await db.IpLocation.destroy({ where: { ip: { [Op.in]: ['41.90.70.10', '102.0.0.9'] } } });
  await db.Setting.destroy({ where: { key: { [Op.like]: 'security.signin.%' } } });
  await db.SettingChangeLog.destroy({ where: { area: 'Sign-in security' } });
  await db.User.destroy({ where: { id: ids } });
  clearSigninSecurityCache();
  await db.sequelize.close();
});

describe('recording sign-ins', () => {
  test('a successful sign-in: clean address, device, outside, sid in the token, looked up once', async () => {
    const r = await loginAs(users.nurse.email, PASSWORD);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.data.signinGeo, 'off');
    const row = await settle(await latestFor({ userId: users.nurse.id }));
    assert.equal(row.outcome, 'success');
    assert.equal(row.ipAddress, '41.90.70.10');
    assert.equal(row.deviceLabel, 'Mac · Chrome');
    assert.equal(row.network, 'outside');
    assert.equal(row.city, 'Mombasa');
    assert.equal(row.countryCode, 'KE');
    assert.equal(row.flagged, false, 'the first recorded device is the baseline');
    const decoded = jwt.verify(r.body.data.token, process.env.JWT_SECRET);
    assert.equal(decoded.sid, row.id);

    const before2 = fetchCalls;
    await settle(await latestFor({ userId: users.nurse.id }));
    assert.equal(fetchCalls, before2, 'a known address is not sent out again');
  });

  test('the clinic network is recognised and not looked up', async () => {
    const calls = fetchCalls;
    await loginAs(users.nurse.email, PASSWORD, { ip: '::ffff:197.248.95.40' });
    const row = await settle(await latestFor({ userId: users.nurse.id }));
    assert.equal(row.network, 'clinic');
    assert.equal(row.networkLabel, 'Main line');
    assert.equal(fetchCalls, calls);
  });

  test('failed attempts are recorded with the reason; the answer does not change', async () => {
    const wrong = await loginAs(users.nurse.email, 'nope');
    assert.equal(wrong.statusCode, 401);
    assert.equal((await latestFor({ userId: users.nurse.id })).failReason, 'wrong_password');

    const unknown = await loginAs(`nobody.${TAG}@example.test`, 'x');
    assert.equal(unknown.statusCode, 401);
    const u = await latestFor({ emailTried: `nobody.${TAG}@example.test` });
    assert.equal(u.outcome, 'failed');
    assert.equal(u.failReason, 'unknown_account');
    assert.equal(u.userId, null);

    const gone = await loginAs(users.gone.email, PASSWORD);
    assert.equal(gone.body.message, unknown.body.message, 'an inactive account reads the same as no account');
    assert.equal((await latestFor({ userId: users.gone.id })).failReason, 'inactive');
  });

  test('patients are never recorded', async () => {
    await loginAs(users.patient.email, PASSWORD);
    await loginAs(users.patient.email, 'wrong');
    assert.equal(await db.UserLoginLog.count({ where: { userId: users.patient.id } }), 0);
  });
});

describe('suspicious sign-ins', () => {
  test('a new device in a new country is flagged and the alert goes to holders only', async () => {
    await loginAs(users.nurse.email, PASSWORD, { ip: '102.0.0.9', ua: UA_ANDROID });
    const row = await settle(await latestFor({ userId: users.nurse.id, outcome: 'success' }));
    assert.equal(row.flagged, true);
    assert.deepEqual(row.flagReasons.split(','), ['new_device', 'new_country']);
    assert.ok(row.alertedAt);
    const toWatcher = await db.Notification.findOne({ where: { assignedDoctorId: users.watcher.id, category: 'security' }, order: [['id', 'DESC']] });
    assert.ok(toWatcher, 'the alerts holder is told');
    assert.match(toWatcher.title, /Suspicious sign-in/);
    assert.match(toWatcher.body, /Dar es Salaam, Tanzania/);
    assert.equal(toWatcher.link, `/admin/sign-ins?focus=${row.id}`);
    assert.equal(await db.Notification.count({ where: { assignedDoctorId: users.broadadmin.id, category: 'security' } }), 0,
      'full administrator access does not receive sign-in alerts');
  });

  test('a burst of wrong passwords raises one alert', async () => {
    await db.UserLoginLog.destroy({ where: { userId: users.nurse.id, outcome: 'failed' } });
    for (let i = 0; i < 4; i++) {
      await loginAs(users.nurse.email, `wrong-${i}`);
      await settle(await latestFor({ userId: users.nurse.id }));
    }
    const failed = await db.UserLoginLog.findAll({ where: { userId: users.nurse.id, outcome: 'failed' }, order: [['id', 'ASC']] });
    assert.deepEqual(failed.map((f) => f.flagged), [false, false, true, false]);
    assert.equal(await db.Notification.count({ where: { assignedDoctorId: users.watcher.id, type: 'signin_failed_attempts' } }), 1);

    // A slow attacker keeps the sliding count at exactly N — still one alert.
    await db.UserLoginLog.destroy({ where: { id: [failed[0].id, failed[1].id] } });
    await loginAs(users.nurse.email, 'wrong-again');
    const slow = await settle(await latestFor({ userId: users.nurse.id }));
    assert.equal(slow.flagged, false);
    assert.equal(await db.Notification.count({ where: { assignedDoctorId: users.watcher.id, type: 'signin_failed_attempts' } }), 1);
  });
});

describe('the device location', () => {
  test('written once, only onto the sign-in in the caller\'s own token, only while the clinic asks', async () => {
    const r = await loginAs(users.nurse.email, PASSWORD);
    const { sid } = jwt.verify(r.body.data.token, process.env.JWT_SECRET);
    const call = async (user, body) => { const out = res(); await auth.signinLocation({ user, body }, out); return out; };

    const off = await call(asUser(users.nurse, { sid }), { status: 'given', lat: -1.26, lng: 36.8, accuracy: 30 });
    assert.equal(off.body.data.recorded, false, 'nothing is written while the clinic does not ask');
    await setSigninSecurityConfig({ gpsMode: 'ask' });

    const other = await call(asUser(users.watcher, { sid }), { status: 'given', lat: -1.26, lng: 36.8, accuracy: 30 });
    assert.equal(other.body.data.recorded, false, 'someone else\'s sid writes nothing');

    const first = await call(asUser(users.nurse, { sid }), { status: 'given', lat: -1.263511, lng: 36.81234, accuracy: 30 });
    assert.equal(first.body.data.recorded, true);
    const again = await call(asUser(users.nurse, { sid }), { status: 'given', lat: 0, lng: 0, accuracy: 1 });
    assert.equal(again.body.data.recorded, false, 'written once');
    const row = await db.UserLoginLog.findByPk(sid);
    assert.equal(row.gpsStatus, 'given');
    assert.equal(Number(row.gpsLat), -1.263511);

    const bad = await call(asUser(users.nurse, { sid }), { status: 'given', lat: 200, lng: 0 });
    assert.equal(bad.statusCode, 400);

    // A late "given" may replace "unavailable" (the prompt was answered after the page stopped waiting).
    const r2 = await loginAs(users.nurse.email, PASSWORD);
    const sid2 = jwt.verify(r2.body.data.token, process.env.JWT_SECRET).sid;
    await call(asUser(users.nurse, { sid: sid2 }), { status: 'unavailable' });
    const late = await call(asUser(users.nurse, { sid: sid2 }), { status: 'given', lat: -1.3, lng: 36.9, accuracy: 15 });
    assert.equal(late.body.data.recorded, true);
    await setSigninSecurityConfig({ gpsMode: 'off' });
  });
});

describe('reading and settings', () => {
  test('totals combine with the filter, never replace it', async () => {
    const r = res();
    await signins.list({ query: { userId: String(users.nurse.id), outcome: 'success' }, user: asUser(users.watcher) }, r);
    assert.equal(r.body.data.totals.failed, 0);
    assert.equal(r.body.data.totals.successful, r.body.data.total);
  });

  test('everyone sees their own sign-ins', async () => {
    const r = res();
    await signins.mine({ user: asUser(users.nurse) }, r);
    assert.ok(r.body.data.signins.length > 0);
    assert.ok(r.body.data.signins.every((x) => x.userId === users.nurse.id));
  });

  test('the list filters and totals', async () => {
    const r = res();
    await signins.list({ query: { userId: String(users.nurse.id), outcome: 'failed' }, user: asUser(users.watcher) }, r);
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.data.signins.every((s) => s.outcome === 'failed'));
    assert.equal(r.body.data.totals.failed, r.body.data.total);
    const flagged = r.body.data.signins.find((s) => s.flagged);
    assert.deepEqual(flagged.flagText, ['repeated wrong passwords']);
  });

  test('settings: a bad network is refused; the token is never returned; changes are audited', async () => {
    const bad = res();
    await signins.updateSettings({ body: { networks: [{ value: '999.1.1.1', label: 'x' }] }, user: asUser(users.watcher), headers: {} }, bad);
    assert.equal(bad.statusCode, 400);
    const ok = res();
    await signins.updateSettings({ body: { lookupToken: 'abc123', gpsMode: 'ask' }, user: asUser(users.watcher), headers: {} }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.data.lookupTokenSet, true);
    assert.equal(ok.body.data.lookupToken, undefined);
    assert.equal(ok.body.data.gpsMode, 'ask');
    await new Promise((r) => setTimeout(r, 200));
    const audit = await db.SettingChangeLog.findAll({ where: { area: 'Sign-in security' } });
    const token = audit.find((a) => /lookupToken/.test(a.settingKey));
    assert.equal(token.newValue, '(changed)', 'the token itself is never written to the audit');

    const r = await loginAs(users.nurse.email, PASSWORD);
    assert.equal(r.body.data.signinGeo, 'ask', 'the browser is told to ask once the clinic switches it on');

    const view = res();
    await signins.getSettings({ user: asUser(users.watcher), ip: '197.248.95.12', socket: {} }, view);
    assert.deepEqual(view.body.data.yourAddress, { ip: '197.248.95.12', public: true, matches: '197.248.95.0/24' });
  });

  test('the Activity Log shows where from only to someone who may see sign-ins', async () => {
    const read = async (user) => {
      const r = res();
      await activity.getActivityLog({ query: { action: 'all' }, user }, r);
      return r.body.data.events.filter((e) => e.staff.includes(TAG));
    };
    const broad = await read(asUser(users.broadadmin));
    assert.ok(broad.some((e) => e.type === 'user_login'));
    assert.ok(broad.filter((e) => e.type === 'user_login').every((e) => e.detail === null));
    assert.equal(broad.some((e) => e.type === 'user_login_failed'), false);

    const holder = await read(asUser(users.watcher));
    assert.ok(holder.some((e) => e.type === 'user_login' && /Outside the clinic · Mombasa, Kenya/.test(e.detail || '')));
    assert.ok(holder.some((e) => e.type === 'user_login_failed'));
  });
});

describe('the network lock', () => {
  const clinicIp = '197.248.95.40';
  const homeIp = '41.90.70.10';
  const through = async (token, ip) => {
    const r = res(); let passed = false;
    await authenticate({ headers: { authorization: `Bearer ${token}` }, originalUrl: '/api/queue', ip, socket: {} }, r, () => { passed = true; });
    return { passed, r };
  };

  test('cannot be switched on without a clinic network, nor by someone it would lock out', async () => {
    await setSigninSecurityConfig({ networks: [] });
    await assert.rejects(setSigninSecurityConfig({ lockOutside: true }), /clinic's network first/);
    await setSigninSecurityConfig({ networks: [{ value: '197.248.95.0/24', label: 'Main line' }] });
    const r = res();
    await signins.updateSettings({ body: { lockOutside: true }, user: asUser(users.watcher), ip: homeIp, headers: {}, socket: {} }, r);
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /lock you out/);
    const ok = res();
    await signins.updateSettings({ body: { lockOutside: true }, user: asUser(users.watcher), ip: clinicIp, headers: {}, socket: {} }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.data.lockOutside, true);
  });

  test('outside without remote access: refused at sign-in and recorded', async () => {
    const r = await loginAs(users.nurse.email, PASSWORD, { ip: homeIp });
    assert.equal(r.statusCode, 423);
    assert.equal(r.body.code, 'OUTSIDE_CLINIC');
    assert.equal((await latestFor({ userId: users.nurse.id })).failReason, 'outside_blocked');
    const inside = await loginAs(users.nurse.email, PASSWORD, { ip: clinicIp });
    assert.equal(inside.statusCode, 200);
  });

  test('remote access and the main admin account pass; patients are never locked', async () => {
    assert.equal((await loginAs(users.remote.email, PASSWORD, { ip: homeIp })).statusCode, 200);
    assert.notEqual((await loginAs(users.patient.email, PASSWORD, { ip: homeIp })).statusCode, 423);
    assert.equal((await loginAs(users.broadadmin.email, PASSWORD, { ip: homeIp })).statusCode, 423,
      'full administrator access does not carry remote access');
  });

  test('a session that leaves the clinic network stops working', async () => {
    const r = await loginAs(users.nurse.email, PASSWORD, { ip: clinicIp });
    const token = r.body.data.token;
    assert.equal((await through(token, clinicIp)).passed, true);
    const away = await through(token, homeIp);
    assert.equal(away.passed, false);
    assert.equal(away.r.statusCode, 401);
    assert.equal(away.r.body.code, 'OUTSIDE_CLINIC');
  });

  test('removing the last clinic network switches the lock off', async () => {
    const after = await setSigninSecurityConfig({ networks: [] });
    assert.equal(after.lockOutside, false);
    await setSigninSecurityConfig({ networks: [{ value: '197.248.95.0/24', label: 'Main line' }], lockOutside: false });
  });
});
