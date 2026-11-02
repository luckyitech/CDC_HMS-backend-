const { test, before, beforeEach, after, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

const db = require('../models');
const auth = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { gateFor, forgetAnswer } = require('../services/checkinGate');
const svc = require('../services/hrAttendanceService');
const { setSigninSecurityConfig } = require('../utils/signinSecurityConfig');

// =====================================================================
// The check-in gate (2 Nov 2026, Emu) — real database. "now" is passed to
// gateFor; the login and middleware cases fix the clock at Monday 10:00.
// =====================================================================

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run gate tests against production.');

const TAG = 'gate-test';
const PASSWORD = 'Correct-horse-1';
const users = {};
let scanner;

// Monday 2 Nov 2026 (clinic 08:00–17:00), and the Sunday before.
const at = (iso) => new Date(`${iso}+03:00`);
const MON_10 = at('2026-11-02T10:00:00');
const MON_0630 = at('2026-11-02T06:30:00');
const MON_0530 = at('2026-11-02T05:30:00');
const MON_1830 = at('2026-11-02T18:30:00');
const SUN_10 = at('2026-11-01T10:00:00');

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const mkUser = async (key, role, permissions = [], extra = {}) => {
  users[key] = await db.User.create({
    firstName: key[0].toUpperCase() + key.slice(1), lastName: TAG, email: `${key}.${TAG}@example.test`,
    password: await bcrypt.hash(PASSWORD, 4), role, isActive: true, permissions, ...extra,
  });
  return users[key];
};
const link = async (u, userNo) => db.HrScannerUser.create({ scannerId: scanner.id, userNo, status: 'linked', UserId: u.id, onScanner: true });
const reload = async (key) => { users[key] = await db.User.findByPk(users[key].id); return users[key]; };
// Online / offline as seen from Monday 10:00 (the scanner reported a minute ago, or an hour ago).
const setOnline = (online) => scanner.update({ lastSeenAt: new Date(MON_10.getTime() - (online ? 60 : 3600) * 1000) });

before(async () => {
  await db.sequelize.authenticate();
  await setSigninSecurityConfig({ networks: [], lockOutside: false, alertsEnabled: false });
  scanner = await db.HrScanner.create({ serial: `GATE${Date.now() % 1e8}`, label: 'Reception scanner', keyHash: 'x'.repeat(64), status: 'active', goLiveAt: at('2026-10-01T00:00:00'), lastSeenAt: new Date(MON_10.getTime() - 60 * 1000) });
  await mkUser('nurse', 'nurse');            // linked, must check in
  await mkUser('fresh', 'staff');            // no scanner ID, no phone
  await mkUser('visitor', 'doctor', ['hr.checkin.exempt']);
  await mkUser('broad', 'doctor', ['admin.access']);
  await mkUser('boss', 'admin');
  await mkUser('pat', 'patient');
  await link(users.nurse, '9001');
  await link(users.visitor, '9002');
  await link(users.broad, '9003');
});

// Each case asks afresh (the gate remembers open answers for a minute).
beforeEach(() => forgetAnswer());

after(async () => {
  const ids = Object.values(users).map((u) => u.id);
  await db.StaffAttendance.destroy({ where: { UserId: { [Op.in]: ids } } });
  await db.HrScannerUser.destroy({ where: { UserId: { [Op.in]: ids } } });
  await db.HrScanner.destroy({ where: { serial: { [Op.like]: 'GATE%' } } });
  await db.UserDevice.destroy({ where: { UserId: { [Op.in]: ids } } });
  await db.UserLoginLog.destroy({ where: { userId: { [Op.in]: ids } } });
  await db.Notification.destroy({ where: { type: 'checkin_gate_offline' } });
  await db.User.destroy({ where: { id: { [Op.in]: ids } } });
  await db.sequelize.close();
});

describe('who is held', () => {
  test('a linked nurse with no check-in today is held, with what the card shows', async () => {
    const g = await gateFor(users.nurse, MON_10);
    assert.equal(g.held, true);
    assert.equal(g.why, 'not_checked_in');
    assert.equal(g.details.firstName, 'Nurse');
    assert.equal(g.details.scanner.label, 'Reception scanner');
    assert.equal(g.details.retrySeconds, 15);
  });

  test('never held: patients, the main admin account', async () => {
    assert.equal((await gateFor(users.pat, MON_10)).why, 'patient');
    assert.equal((await gateFor(users.boss, MON_10)).why, 'admin');
  });

  test('full administrator access does not carry the exemption', async () => {
    const g = await gateFor(users.broad, MON_10);
    assert.equal(g.held, true);
  });

  test('the exemption: no end date, an end date today (inclusive), an end date passed', async () => {
    assert.equal((await gateFor(users.visitor, MON_10)).why, 'exempt');
    await users.visitor.update({ checkinExemptUntil: '2026-11-02' });
    forgetAnswer();
    assert.equal((await gateFor(users.visitor, MON_10)).why, 'exempt');
    await users.visitor.update({ checkinExemptUntil: '2026-11-01' });
    forgetAnswer();
    assert.equal((await gateFor(users.visitor, MON_10)).held, true);
    await users.visitor.update({ checkinExemptUntil: null });
  });

  test('a withdrawn exemption holds', async () => {
    await users.visitor.update({ deniedPermissions: ['hr.checkin.exempt'] });
    assert.equal((await gateFor(await reload('visitor'), MON_10)).held, true);
    await users.visitor.update({ deniedPermissions: [] });
    await reload('visitor');
  });

  test('outside clinic hours the gate is open: Sunday, before 06:00, after closing', async () => {
    assert.equal((await gateFor(users.nurse, SUN_10)).why, 'closed');
    forgetAnswer();
    assert.equal((await gateFor(users.nurse, MON_0530)).why, 'closed');
    forgetAnswer();
    assert.equal((await gateFor(users.nurse, MON_1830)).why, 'closed');
    forgetAnswer();
    assert.equal((await gateFor(users.nurse, MON_0630)).held, true, 'two hours before opening the gate applies');
  });

  test('no scanner ID and no check-in phone: never locked out', async () => {
    assert.equal((await gateFor(users.fresh, MON_10)).why, 'no_checkin_method');
  });

  test('a check-in phone counts as a way to check in', async () => {
    const phone = await db.UserDevice.create({ UserId: users.fresh.id, tokenHash: require('crypto').randomBytes(32).toString('hex'), label: 'iPhone · Safari', expiresAt: new Date(Date.now() + 86400000) });
    assert.equal((await gateFor(users.fresh, MON_10)).held, true);
    await phone.update({ revokedAt: new Date() });
    forgetAnswer();
    assert.equal((await gateFor(users.fresh, MON_10)).why, 'no_checkin_method');
    await phone.destroy();
  });

  test('every scanner offline: let in', async () => {
    await setOnline(false);
    assert.equal((await gateFor(users.nurse, MON_10)).why, 'scanner_offline');
    await setOnline(true);
  });

  test('a scanner ID taken off the scanner, or on a retired scanner, is not a way to check in', async () => {
    const u = await mkUser('removed', 'staff');
    const row = await link(u, '9101');
    await row.update({ onScanner: false });
    assert.equal((await gateFor(u, MON_10)).why, 'no_checkin_method');
    const old = await db.HrScanner.create({ serial: `GATEOLD${Date.now() % 1e6}`, label: 'Old scanner', keyHash: 'y'.repeat(64), status: 'stopped', goLiveAt: at('2026-01-01T00:00:00'), lastSeenAt: MON_10 });
    await row.update({ onScanner: true, scannerId: old.id });
    forgetAnswer();
    assert.equal((await gateFor(u, MON_10)).why, 'no_checkin_method');
  });

  test('their own scanner offline lets them in, even when another scanner is online', async () => {
    const u = await mkUser('upstairs', 'nurse');
    const far = await db.HrScanner.create({ serial: `GATEFAR${Date.now() % 1e6}`, label: 'Upstairs scanner', keyHash: 'z'.repeat(64), status: 'active', goLiveAt: at('2026-10-01T00:00:00'), lastSeenAt: new Date(MON_10.getTime() - 3600 * 1000) });
    await db.HrScannerUser.create({ scannerId: far.id, userNo: '9201', status: 'linked', UserId: u.id, onScanner: true });
    assert.equal((await gateFor(u, MON_10)).why, 'scanner_offline');
  });

  test('a check-in phone still works with the scanner offline, so its owner is held', async () => {
    await setOnline(false);
    const phone = await db.UserDevice.create({ UserId: users.nurse.id, tokenHash: require('crypto').randomBytes(32).toString('hex'), label: 'Android · Chrome', expiresAt: new Date(MON_10.getTime() + 86400000) });
    assert.equal((await gateFor(users.nurse, MON_10)).held, true);
    await phone.destroy();
    await setOnline(true);
  });

  test('a failed lookup never holds anyone', async () => {
    const real = svc.expectedFor;
    svc.expectedFor = async () => { throw new Error('settings table missing'); };
    try {
      const g = await gateFor(users.nurse, MON_10);
      assert.equal(g.held, false);
      assert.equal(g.why, 'error');
    } finally { svc.expectedFor = real; }
  });

  test('checked in today opens the gate — and stays open after a punch-out', async () => {
    await db.StaffAttendance.create({
      UserId: users.nurse.id, clinicDate: '2026-11-02', checkInAt: at('2026-11-02T07:55:00'), checkOutAt: at('2026-11-02T13:00:00'),
      checkInMethod: 'fingerprint', checkInVerification: 'verified', checkInPunctuality: 'early', checkOutPunctuality: 'early', status: 'closed', createdById: users.nurse.id,
    });
    assert.equal((await gateFor(users.nurse, MON_10)).why, 'checked_in');
  });

  test('a voided or refused row is not a check-in', async () => {
    await db.StaffAttendance.create({
      UserId: users.broad.id, clinicDate: '2026-11-02', checkInAt: at('2026-11-02T08:00:00'),
      checkInMethod: 'nfc', checkInVerification: 'refused', checkInPunctuality: 'none', checkOutPunctuality: 'none', status: 'refused', createdById: users.broad.id,
    });
    assert.equal((await gateFor(users.broad, MON_10)).held, true);
  });
});

describe('at sign-in and on an old session (Monday 10:00)', () => {
  before(() => { mock.timers.enable({ apis: ['Date'], now: MON_10.getTime() }); });
  after(() => { mock.timers.reset(); });
  const login = async (u) => {
    const r = res();
    await auth.login({ body: { email: u.email, password: PASSWORD }, ip: '10.0.0.5', headers: { 'user-agent': 'test' }, socket: {} }, r);
    return r;
  };
  const viaAuth = async (u, iat) => {
    const token = jwt.sign({ id: u.id, role: u.role, iat }, process.env.JWT_SECRET);
    const r = res();
    let passed = false;
    await authenticate({ headers: { authorization: `Bearer ${token}` }, originalUrl: '/api/patients', method: 'GET', ip: '10.0.0.5', socket: {} }, r, () => { passed = true; });
    return { r, passed };
  };

  test('login: held → 423 CHECKIN_REQUIRED, recorded once however often the page asks', async () => {
    const first = await login(users.broad);
    assert.equal(first.statusCode, 423, JSON.stringify(first.body));
    assert.equal(first.body.code, 'CHECKIN_REQUIRED');
    assert.ok(first.body.retrySeconds);
    await login(users.broad);
    const rows = await db.UserLoginLog.count({ where: { userId: users.broad.id, failReason: 'checkin_required' } });
    assert.equal(rows, 1);
  });

  test('login: an exempt person signs in', async () => {
    const r = await login(users.visitor);
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.data.token);
  });

  test('a session opened before the gate applied is held once it does — yesterday\'s or this morning\'s', async () => {
    const yesterday = Math.floor(Date.now() / 1000) - 26 * 3600;
    for (const iat of [yesterday, Math.floor(Date.now() / 1000) - 5 * 3600]) {
      forgetAnswer();
      const r = await viaAuth(users.broad, iat);
      assert.equal(r.passed, false);
      assert.equal(r.r.statusCode, 401);
      assert.equal(r.r.body.code, 'CHECKIN_REQUIRED');
    }
    const ok = await viaAuth(users.visitor, Math.floor(Date.now() / 1000));
    assert.equal(ok.passed, true, 'an exempt person works on');
  });

  test('"check again" uses the gate ticket, never the password, and signs in once checked in', async () => {
    const first = await login(users.broad);
    assert.equal(first.statusCode, 423);
    assert.ok(first.body.ticket);
    const again = res();
    await auth.gateCheck({ body: { ticket: first.body.ticket }, ip: '10.0.0.5', headers: { 'user-agent': 'test' }, socket: {} }, again);
    assert.equal(again.statusCode, 423);
    await db.StaffAttendance.destroy({ where: { UserId: users.broad.id } });
    await db.StaffAttendance.create({
      UserId: users.broad.id, clinicDate: '2026-11-02', checkInAt: at('2026-11-02T09:58:00'),
      checkInMethod: 'fingerprint', checkInVerification: 'verified', checkInPunctuality: 'late', checkOutPunctuality: 'none', status: 'open', createdById: users.broad.id,
    });
    forgetAnswer();
    const inNow = res();
    await auth.gateCheck({ body: { ticket: first.body.ticket }, ip: '10.0.0.5', headers: { 'user-agent': 'test' }, socket: {} }, inNow);
    assert.equal(inNow.statusCode, 200, JSON.stringify(inNow.body));
    assert.ok(inNow.body.data.token);
    const forged = res();
    await auth.gateCheck({ body: { ticket: jwt.sign({ id: users.broad.id }, process.env.JWT_SECRET) }, ip: '10.0.0.5', headers: {}, socket: {} }, forged);
    assert.equal(forged.statusCode, 401, 'a session token is not a gate ticket');
  });

  test('a check-in pass is never gated', async () => {
    const yesterday = Math.floor(Date.now() / 1000) - 26 * 3600;
    const token = jwt.sign({ id: users.broad.id, role: 'doctor', scope: 'tap', iat: yesterday }, process.env.JWT_SECRET);
    const r = res();
    let passed = false;
    await authenticate({ headers: { authorization: `Bearer ${token}` }, originalUrl: '/api/hr/attendance/tap', method: 'POST', ip: '10.0.0.5', socket: {} }, r, () => { passed = true; });
    assert.notEqual(r.body?.code, 'CHECKIN_REQUIRED');
    assert.equal(passed, true, JSON.stringify(r.body));
  });
});

describe('the Permissions tab saves the end date with the tick', () => {
  const FUTURE = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
  const { updatePermissions } = require('../controllers/staffController');
  const save = async (caller, target, body) => {
    const profile = await db.StaffProfile.findOne({ where: { UserId: target.id } })
      || await db.StaffProfile.create({ UserId: target.id, employeeId: `EMPG${target.id}`, roleDetails: {} });
    const r = res();
    await updatePermissions({ user: { ...caller.get({ plain: true }), name: 'Admin' }, staffUser: await db.User.findByPk(target.id), staffProfile: profile, body }, r);
    return r;
  };
  after(async () => {
    const ids = Object.values(users).map((u) => u.id);
    await db.UserEditLog.destroy({ where: { targetUserId: { [Op.in]: ids } } });
    await db.StaffProfile.destroy({ where: { UserId: { [Op.in]: ids } }, force: true });
  });

  test('ticked with a date: stored and audited; unticked: the date goes too', async () => {
    const r = await save(users.boss, users.nurse, { permissions: ['hr.checkin.exempt'], checkinExemptUntil: FUTURE });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(String((await reload('nurse')).checkinExemptUntil), FUTURE);
    const log = await db.UserEditLog.findOne({ where: { targetUserId: users.nurse.id }, order: [['id', 'DESC']] });
    const changes = typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes;
    assert.equal(changes.checkinExemptUntil.to, FUTURE);
    // A grants-only save (no date sent) keeps the date.
    await save(users.boss, users.nurse, { permissions: ['hr.checkin.exempt'] });
    assert.equal(String((await reload('nurse')).checkinExemptUntil), FUTURE);
    await save(users.boss, users.nurse, { permissions: [] });
    assert.equal((await reload('nurse')).checkinExemptUntil, null);
  });

  test('an impossible or past end date is refused', async () => {
    for (const bad of ['2026-13-45', '2020-01-01']) {
      const r = await save(users.boss, users.nurse, { permissions: ['hr.checkin.exempt'], checkinExemptUntil: bad });
      assert.equal(r.statusCode, 400, bad);
    }
  });

  test('an HR grantor can neither tick it nor change its date', async () => {
    const hr = await mkUser('grantor', 'doctor', ['hr.grant', 'hr.view']);
    const r = await save(hr, users.fresh, { permissions: ['hr.checkin.exempt'] });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'NOT_DELEGABLE');
  });
});
