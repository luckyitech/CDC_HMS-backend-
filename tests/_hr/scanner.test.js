// =====================================================================
// HR Suite — fingerprint scanner + one session per day (17 Oct 2026).
// Scratch-DB harness like tap.test.js: RUN ONLY via `npm run test:hr` with
// CONFIRM_TEST_DB=1 and a throw-away DB_NAME.
//
// Drives the real controllers with a fake req/res: the relay's heartbeat and
// punches (req.scanner set as scannerAuth would), HR linking, go-live, an NFC
// tap on a fingerprint day, HR's manual entry and amend.
// =====================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });

require('../_guard').assertThrowawayDb('hr scanner test');

const db = require('../../models');
const { Op } = require('sequelize');
const { computeSunMac } = require('../../utils/ntag424');
const { setHrConfig } = require('../../utils/hrConfig');
const { encrypt } = require('../../utils/crypto');
const hrScanner = require('../../controllers/hrScannerController');
const hrAttendance = require('../../controllers/hrAttendanceController');
const { scannerAuth } = require('../../middleware/scannerAuth');
const { clinicToday, clinicDatePlusDays, clinicDateTime } = require('../../utils/clinicTime');

const { User, StaffProfile, HrScanner, HrScannerUser, StaffPunch, StaffAttendance, HrNfcTag } = db;

const call = (fn, { user, body = {}, params = {}, query = {}, headers = {}, scanner } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => resolve({ status: res.statusCode, body: b });
  res.setHeader = () => res;
  res.send = (b) => resolve({ status: res.statusCode, body: b });
  fn({ user, body, params, query, scanner, headers: { 'user-agent': 'test', ...headers }, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }, res);
});
const asUser = (u) => ({ id: u.id, role: u.role, permissions: [], deniedPermissions: [], firstName: u.firstName, lastName: u.lastName, name: `${u.firstName} ${u.lastName}` });

const SERIAL = 'A8N5203760092';
let hr, bridgit, halima, abdul, scanner, key, yesterday, twoDaysAgo;

const relay = async (punches) => {
  const s = await HrScanner.findByPk(scanner.id);
  const r = await call(hrScanner.punches, { scanner: s, body: { punches } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data;
};
const sessionOf = (user, date) => StaffAttendance.findOne({
  where: { UserId: user.id, clinicDate: date, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } },
});
const hhmm = (d) => clinicDateTime(new Date(d)).slice(11, 16);
const usersList = async () => (await call(hrScanner.users, { user: asUser(hr), params: { id: scanner.id } })).body.data.users;

before(async () => {
  await db.sequelize.authenticate();
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=0');
  for (const m of [StaffPunch, HrScannerUser, HrScanner, StaffAttendance, HrNfcTag, db.UserDevice, db.StaffWorkHours, db.UserEditLog, StaffProfile, User, db.Setting, db.SettingChangeLog]) {
    await m.destroy({ where: {}, truncate: true });
  }
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=1');
  hr = await User.create({ firstName: 'Admin', lastName: 'CDC', email: 'admin@cdc.test', password: 'x', role: 'admin', isActive: true });
  bridgit = await User.create({ firstName: 'Bridgit', lastName: 'A', email: 'b@cdc.test', password: 'x', role: 'staff', isActive: true });
  halima = await User.create({ firstName: 'Halima', lastName: 'B', email: 'h@cdc.test', password: 'x', role: 'staff', isActive: true });
  abdul = await User.create({ firstName: 'Abdul', lastName: 'C', email: 'ab@cdc.test', password: 'x', role: 'staff', isActive: true });
  await StaffProfile.create({ UserId: hr.id, employeeId: 'EMP099' });
  await StaffProfile.create({ UserId: bridgit.id, employeeId: 'EMP001' });
  await StaffProfile.create({ UserId: halima.id, employeeId: 'EMP002' });
  await StaffProfile.create({ UserId: abdul.id, employeeId: 'EMP007' });
  await setHrConfig({ debounceSeconds: 120, minSessionMinutes: 10, confirmCheckout: false });
  yesterday = clinicDatePlusDays(-1);
  twoDaysAgo = clinicDatePlusDays(-2);
});

after(async () => { await db.sequelize.close(); });

describe('setting the scanner up', () => {
  test('register: the key is returned once and never stored in clear', async () => {
    const r = await call(hrScanner.create, { user: asUser(hr), body: { serial: SERIAL, label: 'Front office scanner', goLiveAt: new Date(`${twoDaysAgo}T00:00:00+03:00`).toISOString() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    key = r.body.data.key;
    assert.match(key, /^[0-9a-f]{48}$/);
    scanner = await HrScanner.findByPk(r.body.data.id);
    assert.notEqual(scanner.keyHash, key);
    const list = await call(hrScanner.list, { user: asUser(hr) });
    assert.equal(list.body.data[0].key, undefined);
    assert.equal(list.body.data[0].keyHash, undefined);
    assert.equal(list.body.data[0].online, false);
  });

  test('relay auth: wrong key 401, right key passes, stopped scanner 403', async () => {
    const run = (headers) => new Promise((resolve) => {
      const req = { headers };
      const res = { status: (c) => ({ json: (b) => resolve({ status: c, body: b }) }) };
      scannerAuth(req, res, () => resolve({ status: 'next', scanner: req.scanner }));
    });
    assert.equal((await run({ 'x-scanner-key': 'nope', 'x-scanner-serial': SERIAL })).status, 401);
    assert.equal((await run({ 'x-scanner-key': key })).status, 401);
    const ok = await run({ 'x-scanner-key': key, 'x-scanner-serial': SERIAL });
    assert.equal(ok.status, 'next');
    assert.equal(ok.scanner.id, scanner.id);
    await scanner.update({ status: 'stopped' });
    assert.equal((await run({ 'x-scanner-key': key, 'x-scanner-serial': SERIAL })).status, 403);
    await scanner.update({ status: 'active' });
  });

  test('heartbeat: online, user list stored, the relay is told where to start', async () => {
    const r = await call(hrScanner.heartbeat, { scanner, body: { recordCount: 14685, userCount: 4, relayVersion: '1.0.0', users: [
      { userNo: '1', name: 'Bridgit' }, { userNo: '2', name: 'Halima' }, { userNo: '7', name: 'Abdul' }, { userNo: '14', name: 'Kim' },
    ] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.pollSeconds, 60);
    assert.ok(r.body.data.sinceLocal < `${twoDaysAgo} 00:00:00`);
    const status = await call(hrScanner.status, { user: asUser(bridgit) });
    assert.equal(status.body.data[0].online, true);
    assert.equal(await HrScannerUser.count({ where: { scannerId: scanner.id } }), 4);
  });

  test('matches are proposed from the staff number; a number with no staff is flagged', async () => {
    const users = await usersList();
    const by = Object.fromEntries(users.map((u) => [u.userNo, u]));
    assert.equal(by['1'].proposal.id, bridgit.id);
    assert.equal(by['2'].proposal.id, halima.id);
    assert.equal(by['7'].proposal.id, abdul.id);
    assert.equal(by['14'].proposal, null);
    assert.equal(by['14'].noMatchingStaff, true);
    const staff = (await call(hrScanner.users, { user: asUser(hr), params: { id: scanner.id } })).body.data.staff;
    assert.ok(staff.some((p) => p.id === bridgit.id && p.employeeId === 'EMP001'));
  });
});

describe('punches', () => {
  test('punches from unlinked users wait; nothing is counted yet', async () => {
    const d = await relay(['08:31:00', '12:40:00', '13:25:00', '17:05:00'].map((t) => ({ userNo: '1', time: `${yesterday} ${t}`, verify: 1 })));
    assert.equal(d.stored, 4);
    assert.equal(d.counts.unlinked, 4);
    assert.equal(await sessionOf(bridgit, yesterday), null);
    assert.equal((await usersList()).find((u) => u.userNo === '1').waiting, 4);
  });

  test('confirm matches in one click → the waiting punches become her day: first in, last out, ins and outs', async () => {
    const r = await call(hrScanner.confirmMatches, { user: asUser(hr), params: { id: scanner.id } });
    assert.equal(r.body.data.linked, 3);
    const s = await sessionOf(bridgit, yesterday);
    assert.equal(hhmm(s.checkInAt), '08:31');
    assert.equal(hhmm(s.checkOutAt), '17:05');
    assert.equal(s.status, 'closed');
    assert.equal(s.checkInMethod, 'fingerprint');
    assert.deepEqual([s.inCount, s.outCount, s.awayMinutes], [2, 2, 45]);
  });

  test('the same punches sent again change nothing', async () => {
    const d = await relay(['08:31:00', '17:05:00'].map((t) => ({ userNo: '1', time: `${yesterday} ${t}`, verify: 1 })));
    assert.equal(d.stored, 0);
    assert.equal(await StaffPunch.count({ where: { scannerUserNo: '1' } }), 4);
  });

  test('punches arriving out of order still give first in, last out', async () => {
    await relay([{ userNo: '2', time: `${yesterday} 17:00:00`, verify: 1 }]);
    let s = await sessionOf(halima, yesterday);
    assert.equal(s.status, 'missed_checkout');          // one punch on a past day
    await relay([{ userNo: '2', time: `${yesterday} 08:00:00`, verify: 4 }]);
    s = await sessionOf(halima, yesterday);
    assert.equal(hhmm(s.checkInAt), '08:00');
    assert.equal(hhmm(s.checkOutAt), '17:00');
    assert.equal(s.checkInMethod, 'card');
    assert.equal(s.status, 'closed');
  });

  test('a brush within 2 minutes counts once', async () => {
    await relay([{ userNo: '2', time: `${yesterday} 17:00:40`, verify: 1 }]);
    const s = await sessionOf(halima, yesterday);
    assert.deepEqual([s.inCount, s.outCount], [1, 1]);
  });

  test('before go-live is kept, not counted; a future date is implausible', async () => {
    const day3 = clinicDatePlusDays(-3);
    const tomorrow = clinicDatePlusDays(1);
    const d = await relay([{ userNo: '7', time: `${day3} 08:00:00`, verify: 1 }, { userNo: '7', time: `${tomorrow} 08:00:00`, verify: 1 }]);
    assert.equal(d.counts.before_golive, 1);
    assert.equal(d.counts.implausible, 1);
    assert.equal(await sessionOf(abdul, day3), null);
  });

  test('rejects malformed rows without failing the batch', async () => {
    const s = await HrScanner.findByPk(scanner.id);
    const r = await call(hrScanner.punches, { scanner: s, body: { punches: [{ userNo: 'x', time: 'bad' }, { userNo: '7', time: `${twoDaysAgo} 09:00:00`, verify: 1 }] } });
    assert.equal(r.body.data.rejected, 1);
    assert.equal(r.body.data.stored, 1);
  });
});

describe('one session per day across methods', () => {
  test('a fingerprint in and an NFC tap out land on one session', async () => {
    const KEY = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
    const UID = '04A1B2C3D4E5F7';
    const tag = await HrNfcTag.create({ uid: UID, label: 'Main entrance', keyEncrypted: encrypt(KEY), status: 'active', createdById: hr.id });
    const today = clinicToday();
    const twoHoursAgo = clinicDateTime(new Date(Date.now() - 2 * 3600 * 1000));
    if (twoHoursAgo.slice(0, 10) !== today) return;   // too close to midnight to run this case
    await relay([{ userNo: '7', time: twoHoursAgo, verify: 1 }]);
    const counter = 50;
    const r = await call(hrAttendance.tap, { user: asUser(abdul), body: { uid: UID, ctr: counter.toString(16).toUpperCase().padStart(6, '0'), cmac: computeSunMac({ keyHex: KEY, uidHex: UID, counter }) } });
    assert.equal(r.body.data.action, 'checked_out', JSON.stringify(r.body));
    const s = await sessionOf(abdul, today);
    assert.equal(s.checkInMethod, 'fingerprint');
    assert.equal(s.checkOutMethod, 'nfc');
    assert.equal(s.checkOutTagId, tag.id);
    assert.equal(await StaffAttendance.count({ where: { UserId: abdul.id, clinicDate: today } }), 1);
  });

  test('HR manual entry on a day that already has a session is refused', async () => {
    const r = await call(hrAttendance.manual, { user: asUser(hr), body: { userId: halima.id, checkInAt: new Date(`${yesterday}T09:00:00+03:00`).toISOString(), reason: 'test' } });
    assert.equal(r.status, 409);
  });

  test('after HR amends, a later punch is counted but HR\'s times stand', async () => {
    const s = await sessionOf(halima, yesterday);
    const a = await call(hrAttendance.amend, { user: asUser(hr), params: { id: s.id }, body: { checkOutAt: new Date(`${yesterday}T16:00:00+03:00`).toISOString(), reason: 'Left at four, told reception' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    await relay([{ userNo: '2', time: `${yesterday} 18:00:00`, verify: 1 }, { userNo: '2', time: `${yesterday} 18:30:00`, verify: 1 }]);
    const after = await sessionOf(halima, yesterday);
    assert.equal(hhmm(after.checkOutAt), '16:00');
    assert.equal(after.status, 'closed');
    assert.deepEqual([after.inCount, after.outCount], [2, 2]);
  });

  test('the session shows its whole trail of punches', async () => {
    const s = await sessionOf(bridgit, yesterday);
    const r = await call(hrAttendance.getOne, { user: asUser(hr), params: { id: s.id } });
    assert.deepEqual(r.body.data.punches.map((p) => `${hhmm(p.at)} ${p.direction}`), ['08:31 in', '12:40 out', '13:25 in', '17:05 out']);
    assert.equal(r.body.data.awayMinutes, 45);
  });
});

describe('changing links and go-live', () => {
  const bridgitRow = async () => (await usersList()).find((u) => u.userNo === '1');

  test('unlinking takes the punches off her day; linking again puts them back', async () => {
    let r = await call(hrScanner.setLink, { user: asUser(hr), params: { id: scanner.id, userId: (await bridgitRow()).id }, body: { action: 'unlink' } });
    assert.equal(r.status, 200);
    assert.equal(await sessionOf(bridgit, yesterday), null);
    assert.equal((await bridgitRow()).waiting, 4);
    r = await call(hrScanner.setLink, { user: asUser(hr), params: { id: scanner.id, userId: (await bridgitRow()).id }, body: { action: 'link', staffId: bridgit.id } });
    assert.equal(r.status, 200);
    const s = await sessionOf(bridgit, yesterday);
    assert.deepEqual([hhmm(s.checkInAt), hhmm(s.checkOutAt), s.inCount], ['08:31', '17:05', 2]);
  });

  test('one staff member cannot hold two scanner IDs', async () => {
    const kim = (await usersList()).find((u) => u.userNo === '14');
    const r = await call(hrScanner.setLink, { user: asUser(hr), params: { id: scanner.id, userId: kim.id }, body: { action: 'link', staffId: bridgit.id } });
    assert.equal(r.status, 409);
  });

  test('moving go-live later drops earlier punches; moving it back restores them', async () => {
    const today = clinicToday();
    let r = await call(hrScanner.update, { user: asUser(hr), params: { id: scanner.id }, body: { goLiveAt: new Date(`${today}T00:00:00+03:00`).toISOString() } });
    assert.equal(r.status, 200);
    assert.equal(await sessionOf(bridgit, yesterday), null);
    r = await call(hrScanner.update, { user: asUser(hr), params: { id: scanner.id }, body: { goLiveAt: new Date(`${twoDaysAgo}T00:00:00+03:00`).toISOString() } });
    assert.equal(r.status, 200);
    const s = await sessionOf(bridgit, yesterday);
    assert.deepEqual([hhmm(s.checkInAt), hhmm(s.checkOutAt)], ['08:31', '17:05']);
  });

  test('replacing the key stops the old one', async () => {
    const r = await call(hrScanner.replaceKey, { user: asUser(hr), params: { id: scanner.id } });
    assert.notEqual(r.body.data.key, key);
    const run = (k) => new Promise((resolve) => {
      const res = { status: (c) => ({ json: () => resolve(c) }) };
      scannerAuth({ headers: { 'x-scanner-key': k, 'x-scanner-serial': SERIAL } }, res, () => resolve('next'));
    });
    assert.equal(await run(key), 401);
    assert.equal(await run(r.body.data.key), 'next');
  });
});

// ---------------------------------------------------------------------
// Fixes from the independent review (17 Oct 2026)
// ---------------------------------------------------------------------
describe('review fixes', () => {
  let rahma, night;
  before(async () => {
    rahma = await User.create({ firstName: 'Rahma', lastName: 'D', email: 'r@cdc.test', password: 'x', role: 'staff', isActive: true });
    night = await User.create({ firstName: 'Mildred', lastName: 'E', email: 'm@cdc.test', password: 'x', role: 'nurse', isActive: true });
    await StaffProfile.create({ UserId: rahma.id, employeeId: 'EMP009' });
    await StaffProfile.create({ UserId: night.id, employeeId: 'EMP005' });
    await call(hrScanner.heartbeat, { scanner: await HrScanner.findByPk(scanner.id), body: { users: [
      { userNo: '1', name: 'Bridgit' }, { userNo: '2', name: 'Halima' }, { userNo: '7', name: 'Abdul' }, { userNo: '14', name: 'Kim' },
      { userNo: '9', name: 'Rahma' }, { userNo: '5', name: 'Mildred' },
    ] } });
    await call(hrScanner.confirmMatches, { user: asUser(hr), params: { id: scanner.id } });
  });

  test('#1 a voided session stays voided when the person punches again', async () => {
    await relay([{ userNo: '9', time: `${twoDaysAgo} 08:00:00`, verify: 1 }]);
    const s = await sessionOf(rahma, twoDaysAgo);
    const v = await call(hrAttendance.amend, { user: asUser(hr), params: { id: s.id }, body: { status: 'voided', reason: 'Tapped on her day off by mistake' } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    await relay([{ userNo: '9', time: `${twoDaysAgo} 17:00:00`, verify: 1 }]);
    const again = await sessionOf(rahma, twoDaysAgo);
    assert.equal(hhmm(again.checkInAt), '17:00');               // a fresh day, not the voided one back
    assert.equal(again.inCount, 1);
    assert.equal((await StaffAttendance.findByPk(s.id)).status, 'voided');
  });

  test('#2 HR corrects an open session\'s check-in; the evening punch still checks out', async () => {
    const d = clinicDatePlusDays(-1);
    await relay([{ userNo: '9', time: `${d} 08:10:00`, verify: 1 }]);
    let s = await sessionOf(rahma, d);
    const a = await call(hrAttendance.amend, { user: asUser(hr), params: { id: s.id }, body: { checkInAt: new Date(`${d}T07:55:00+03:00`).toISOString(), status: 'open', reason: 'Arrived 07:55, scanner busy' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    await relay([{ userNo: '9', time: `${d} 17:20:00`, verify: 1 }]);
    s = await sessionOf(rahma, d);
    assert.equal(hhmm(s.checkInAt), '07:55');                   // HR's check-in stands
    assert.equal(hhmm(s.checkOutAt), '17:20');                  // the punch closed the day
    assert.equal(s.status, 'closed');
  });

  test('#4 a night shift with a break stays one session on the night it began', async () => {
    await db.StaffWorkHours.create({ UserId: night.id, date: twoDaysAgo, startTime: '19:00:00', endTime: '07:00:00', isOff: false, status: 'active' });
    await relay([
      { userNo: '5', time: `${twoDaysAgo} 18:55:00`, verify: 1 },
      { userNo: '5', time: `${yesterday} 02:00:00`, verify: 1 },
      { userNo: '5', time: `${yesterday} 02:30:00`, verify: 1 },
      { userNo: '5', time: `${yesterday} 07:05:00`, verify: 1 },
    ]);
    const s = await sessionOf(night, twoDaysAgo);
    assert.deepEqual([hhmm(s.checkInAt), hhmm(s.checkOutAt), s.status, s.inCount, s.outCount, s.awayMinutes], ['18:55', '07:05', 'closed', 2, 2, 30]);
    assert.equal(await sessionOf(night, yesterday), null);
  });

  test('#3 punches left pending are processed on the next heartbeat', async () => {
    await StaffPunch.create({ scannerId: scanner.id, scannerUserNo: '9', at: new Date(`${yesterday}T12:00:00+03:00`), source: 'fingerprint', outcome: 'pending' });
    await call(hrScanner.heartbeat, { scanner: await HrScanner.findByPk(scanner.id), body: { scannerTime: clinicDateTime(new Date(Date.now() + 5 * 60000)) } });
    assert.equal(await StaffPunch.count({ where: { scannerId: scanner.id, outcome: 'pending' } }), 0);
    const s = await HrScanner.findByPk(scanner.id);
    assert.ok(s.clockDriftSeconds >= 290 && s.clockDriftSeconds <= 310, String(s.clockDriftSeconds));
  });

  test('#6 linking needs the right to amend that person\'s attendance', async () => {
    const tagsOnly = await User.create({ firstName: 'Tags', lastName: 'Only', email: 't@cdc.test', password: 'x', role: 'staff', isActive: true });
    const kim = (await usersList()).find((u) => u.userNo === '14');
    const r = await call(hrScanner.setLink, { user: { ...asUser(tagsOnly), permissions: ['hr.tags'] }, params: { id: scanner.id, userId: kim.id }, body: { action: 'link', staffId: halima.id } });
    assert.equal(r.status, 403);
  });

  test('#7 an HR manual entry minutes long is closed, not left open', async () => {
    const d = clinicDatePlusDays(-4);
    const r = await call(hrAttendance.manual, { user: asUser(hr), body: { userId: abdul.id, checkInAt: new Date(`${d}T08:00:00+03:00`).toISOString(), checkOutAt: new Date(`${d}T08:05:00+03:00`).toISOString(), reason: 'Came in briefly' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'closed');
  });
});

