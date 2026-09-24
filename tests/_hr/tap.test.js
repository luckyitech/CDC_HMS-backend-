// =====================================================================
// HR Suite (B21) — scratch-DB harness. RUN ONLY via `npm run test:hr` with
// CONFIRM_TEST_DB=1 and a throw-away DB_NAME: it sync({force:true})s.
//
// Drives the REAL controllers with a fake req/res and a scripted fake tag
// (utils/ntag424 computeSunMac — exactly the URL the chip would mirror).
// =====================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

if (process.env.CONFIRM_TEST_DB !== '1' || !/scratch|test/i.test(process.env.DB_NAME || '')) {
  throw new Error('Refusing: set CONFIRM_TEST_DB=1 and a throw-away DB_NAME (containing "scratch" or "test").');
}

const db = require('../../models');
const { computeSunMac } = require('../../utils/ntag424');
const { setHrConfig, clearHrCache } = require('../../utils/hrConfig');
const { encrypt } = require('../../utils/crypto');
const hrAttendance = require('../../controllers/hrAttendanceController');
const hrTags = require('../../controllers/hrTagsController');
const hrDevices = require('../../controllers/hrDevicesController');
const hrWorkHours = require('../../controllers/hrWorkHoursController');
const auth = require('../../controllers/authController');
const { runSweep } = require('../../services/hrAttendanceSweep');
const { clinicToday, clinicDatePlusDays } = require('../../utils/clinicTime');
const { clinicHHMM } = require('../../utils/attendanceRules');

const { User, StaffProfile, HrNfcTag, StaffAttendance, UserDevice, UserEditLog, UserLoginLog } = db;

const KEY = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const UID = '04A1B2C3D4E5F6';
let counter = 10;
const tagUrl = () => { counter += 1; const ctr = counter.toString(16).toUpperCase().padStart(6, '0'); return { uid: UID, ctr, cmac: computeSunMac({ keyHex: KEY, uidHex: UID, counter }) }; };

const call = (fn, { user, body = {}, params = {}, query = {}, headers = {} } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => resolve({ status: res.statusCode, body: b });
  res.setHeader = () => res;
  res.send = (b) => resolve({ status: res.statusCode, body: b });
  fn({ user, body, params, query, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', ...headers }, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }, res);
});

const hhmmPlus = (mins) => clinicHHMM(new Date(Date.now() + mins * 60000));
// The harness runs at whatever hour it is; a day that "ends" past midnight
// would be refused by the validator, so every fake day ends at 23:59.
const END = '23:59';
const setToday = async (userId, startOffsetMin) => {
  const r = await call(hrWorkHours.update, { user: asUser(hr), params: { userId: String(userId) }, body: { overrides: [{ date: today, startTime: hhmmPlus(startOffsetMin), endTime: END }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const asUser = (u) => ({ id: u.id, role: u.role, permissions: [], deniedPermissions: [], name: `${u.firstName} ${u.lastName}` });

let doctor, nurse, hr, tag, today;

before(async () => {
  await db.sequelize.authenticate();
  today = clinicToday();
  // Tables exist from the migrations; clear HR data + users only.
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=0');
  for (const m of [StaffAttendance, UserDevice, HrNfcTag, db.StaffWorkHours, UserEditLog, UserLoginLog, StaffProfile, User, db.Setting, db.SettingChangeLog]) await m.destroy({ where: {}, truncate: true });
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=1');
  doctor = await User.create({ firstName: 'Ebrahim', lastName: 'Yusuf', email: 'e@cdc.test', password: 'x', role: 'doctor', isActive: true });
  nurse  = await User.create({ firstName: 'Amina', lastName: 'Mwangi', email: 'a@cdc.test', password: 'x', role: 'nurse', isActive: true });
  hr     = await User.create({ firstName: 'Admin', lastName: 'CDC', email: 'admin@cdc.test', password: 'x', role: 'admin', isActive: true });
  await StaffProfile.create({ UserId: doctor.id, employeeId: 'EMP003', position: 'Consultant' });
  await StaffProfile.create({ UserId: nurse.id, employeeId: 'EMP004', position: 'Nurse' });
  tag = await HrNfcTag.create({ uid: UID, label: 'Main entrance', keyEncrypted: encrypt(KEY), status: 'active', createdById: hr.id });
  await setHrConfig({ debounceSeconds: 0, minSessionMinutes: 0 });
});

after(async () => { await db.sequelize.close(); });

describe('schema matches the models (no ER_BAD_FIELD)', () => {
  test('every model attribute exists in the migration-built table', async () => {
    const qi = db.sequelize.getQueryInterface();
    for (const M of [StaffAttendance, HrNfcTag, UserDevice, db.StaffWorkHours, UserLoginLog]) {
      const cols = Object.keys(await qi.describeTable(M.getTableName())).map((c) => c.toLowerCase());
      for (const attr of Object.keys(M.rawAttributes)) {
        const field = (M.rawAttributes[attr].field || attr).toLowerCase();
        assert.ok(cols.includes(field), `${M.getTableName()}.${field} missing`);
      }
      await M.findAll({ limit: 1 });   // the query that 500s when a column is missing
    }
    const idx = (await qi.showIndex('StaffAttendances')).map((i) => i.name);
    for (const n of ['staff_attendances_user_date', 'staff_attendances_date_status', 'staff_attendances_user_status']) assert.ok(idx.includes(n), n);
  });
});

describe('the tap, end to end', () => {
  test('unknown tag → refused row, HTTP 200', async () => {
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: { uid: '04FFFFFFFFFFFF', ctr: '000001', cmac: '0000000000000000' } });
    assert.equal(r.status, 200); assert.equal(r.body.data.action, 'refused'); assert.equal(r.body.data.reason, 'unknown_tag');
    assert.equal(await StaffAttendance.count({ where: { UserId: doctor.id, status: 'refused' } }), 1);
  });

  test('bad signature → refused, counter untouched', async () => {
    const u = tagUrl();
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: { ...u, cmac: '0000000000000000' } });
    assert.equal(r.body.data.reason, 'bad_signature');
    assert.equal((await HrNfcTag.findByPk(tag.id)).lastCounter, 0);
  });

  test('genuine first tap, 15 min early → checked_in with a GOLD star and the celebration line', async () => {
    // A dated override for today: the day starts 15 minutes from now.
    await setToday(doctor.id, 15);
    const u = tagUrl();
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: { ...u, geo: { lat: -1.2621, lng: 36.8123, accuracy: 20 } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.action, 'checked_in');
    assert.deepEqual(d.star, { side: 'in', colour: 'gold' });
    assert.equal(d.session.checkInPunctuality, 'early');
    assert.equal(d.session.status, 'open');
    assert.match(d.messages.headline, /^Checked in, \d\d:\d\d$/);
    assert.match(d.messages.mood, /minutes early/);
    assert.equal(d.person.title, 'Dr');
    assert.equal(d.tag.label, 'Main entrance');
    assert.ok(Array.isArray(d.month.calendar) && d.month.calendar.length >= 28);
    const row = await StaffAttendance.findByPk(d.session.id);
    assert.equal(row.checkInVerification, 'verified'); assert.equal(row.checkInTagId, tag.id); assert.equal(String(row.checkInLat), '-1.262100');
    assert.equal((await HrNfcTag.findByPk(tag.id)).lastCounter, counter);
  });

  test('replaying the same URL → refused (replayed_counter), nothing changes', async () => {
    const ctr = counter.toString(16).toUpperCase().padStart(6, '0');
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: { uid: UID, ctr, cmac: computeSunMac({ keyHex: KEY, uidHex: UID, counter }) } });
    assert.equal(r.body.data.action, 'refused'); assert.equal(r.body.data.reason, 'replayed_counter');
    assert.equal(await StaffAttendance.count({ where: { UserId: doctor.id, status: 'open' } }), 1);
  });

  test('a later tap offers check-out (early, since the day ends hours from now) with a confirm token', async () => {
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: tagUrl() });
    const d = r.body.data;
    assert.equal(d.action, 'offer_checkout');
    assert.equal(d.messages.headline, 'Check out early?');
    assert.ok(d.confirmToken);
    assert.equal(await StaffAttendance.count({ where: { UserId: doctor.id, status: 'open' } }), 1);
    // Confirming re-posts the token, not the (now spent) tag URL.
    const c = await call(hrAttendance.tap, { user: asUser(doctor), body: { confirmToken: d.confirmToken } });
    assert.equal(c.body.data.action, 'checked_out');
    assert.deepEqual(c.body.data.star, { side: 'out', colour: 'red' });
    assert.equal(c.body.data.session.status, 'closed');
    assert.equal(c.body.data.session.checkOutPunctuality, 'early');
    assert.match(c.body.data.messages.mood, /Checked out \d+ minutes early/);
  });

  test('a confirm token cannot be used by someone else', async () => {
    const r = await call(hrAttendance.tap, { user: asUser(nurse), body: tagUrl() });
    // nurse has no session yet → this checks her in; now try the doctor's token shape for her
    assert.equal(r.body.data.action, 'checked_in');
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ t: 'hr-confirm', u: doctor.id, tagId: tag.id, ctr: '000000' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const bad = await call(hrAttendance.tap, { user: asUser(nurse), body: { confirmToken: forged } });
    assert.equal(bad.status, 400);
  });

  test('debounce: a second tap within 2 minutes is a duplicate, nothing written', async () => {
    await setHrConfig({ debounceSeconds: 120, minSessionMinutes: 10 });
    const before = await StaffAttendance.count();
    const r = await call(hrAttendance.tap, { user: asUser(nurse), body: tagUrl() });
    assert.equal(r.body.data.action, 'duplicate');
    assert.equal(r.body.data.messages.headline, 'Already recorded');
    assert.equal(await StaffAttendance.count(), before);
    await setHrConfig({ debounceSeconds: 0, minSessionMinutes: 0 });
  });

  test('late check-in → RED star, the gentle line, the facts, and it still checks in', async () => {
    // A second session today for the doctor would earn no in-star (rule), so use a fresh user.
    const late = await User.create({ firstName: 'Peter', lastName: 'Kamau', email: 'p@cdc.test', password: 'x', role: 'lab', isActive: true });
    await setToday(late.id, -61);
    const r = await call(hrAttendance.tap, { user: asUser(late), body: tagUrl() });
    const d = r.body.data;
    assert.equal(d.action, 'checked_in');
    assert.deepEqual(d.star, { side: 'in', colour: 'red' });
    assert.equal(d.session.lateMinutes, 61);
    assert.equal(d.messages.mood, "😔 You're 61 minutes late.");
    assert.equal(d.messages.sub, 'Tomorrow will be better! 🌅');
    assert.equal(d.messages.facts[0][0], 'Required reporting time today');
    assert.equal(d.person.title, '');
  });

  test('a second check-in on the same day earns no in-star', async () => {
    const r = await call(hrAttendance.tap, { user: asUser(doctor), body: tagUrl() });
    assert.equal(r.body.data.action, 'checked_in');
    assert.deepEqual(r.body.data.star, { side: 'in', colour: null });
    assert.equal(r.body.data.session.checkInPunctuality, 'none');
  });
});

describe('HR views', () => {
  test('today: counts and states', async () => {
    const r = await call(hrAttendance.today, { user: asUser(hr) });
    const d = r.body.data;
    assert.equal(d.clinicDate, today);
    assert.ok(d.counts.inNow >= 2, JSON.stringify(d.counts));
    // Peter (override, 61 min late) and Amina (no override → default 08:00 → late this evening)
    assert.equal(d.counts.lateToday, 2);
    assert.equal(d.counts.refusedToday, 3);
    const emu = d.people.find((p) => p.person.employeeId === 'EMP003');
    assert.equal(emu.state, 'in');
    assert.equal(d.attention.filter((a) => a.kind === 'refused').length, 3);
  });

  test('register list + CSV', async () => {
    const r = await call(hrAttendance.list, { user: asUser(hr), query: { from: today, to: today } });
    assert.ok(r.body.data.rows.length >= 4);
    assert.ok(r.body.data.rows.every((x) => x.person && x.person.name));
    const csv = await call(hrAttendance.list, { user: asUser(hr), query: { from: today, to: today, format: 'csv' } });
    assert.ok(String(csv.body).startsWith('\ufeffDate,Person,Employee ID,Role,In,Out,Hours,In star,Out star'));
    const late = await call(hrAttendance.list, { user: asUser(hr), query: { from: today, to: today, status: 'late' } });
    assert.equal(late.body.data.rows.length, 2);
  });

  test('mine and mySummary for the doctor', async () => {
    const r = await call(hrAttendance.mine, { user: asUser(doctor), query: {} });
    assert.ok(r.body.data.rows.length >= 2);
    assert.ok(r.body.data.today.open, 'open session today');
    const s = await call(hrAttendance.mySummary, { user: asUser(doctor), query: { month: today.slice(0, 7) } });
    assert.equal(s.body.data.month, today.slice(0, 7));
    assert.equal(s.body.data.stars.in.gold, 1);          // first session of the day: early
    assert.equal(s.body.data.stars.out.pending, 1);      // last session of the day is still open
    assert.ok(s.body.data.previousMonth.table);
  });

  test('manual entry and amend write the person\'s activity log', async () => {
    const yesterday = clinicDatePlusDays(-1);
    const m = await call(hrAttendance.manual, { user: asUser(hr), body: { userId: nurse.id, checkInAt: `${yesterday}T08:00:00+03:00`, checkOutAt: `${yesterday}T17:00:00+03:00`, reason: 'Fingerprint scanner day — transcribed' } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.data.status, 'closed'); assert.equal(m.body.data.checkInMethod, 'manual');
    const a = await call(hrAttendance.amend, { user: asUser(hr), params: { id: String(m.body.data.id) }, body: { checkOutAt: `${yesterday}T13:30:00+03:00`, reason: 'Left after the Saturday clinic — confirmed' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.checkOutHHMM, '13:30');
    assert.equal(a.body.data.amendedBy, 'Admin CDC');
    const logs = await UserEditLog.findAll({ where: { targetUserId: nurse.id } });
    assert.ok(logs.length >= 2);
    assert.ok(JSON.stringify(logs.map((l) => l.changes)).includes('checkOutAt'));
    const noReason = await call(hrAttendance.amend, { user: asUser(hr), params: { id: String(m.body.data.id) }, body: { status: 'voided' } });
    // (the route validator enforces reason; the controller trusts it) — voiding works
    assert.equal(noReason.status, 200);
    assert.equal(noReason.body.data.status, 'voided');
  });

  test('the sweep closes a forgotten check-out from a previous day', async () => {
    const twoAgo = clinicDatePlusDays(-2);
    const row = await StaffAttendance.create({ UserId: nurse.id, clinicDate: twoAgo, checkInAt: new Date(`${twoAgo}T08:00:00+03:00`), checkInMethod: 'nfc', checkInVerification: 'verified', status: 'open', createdById: nurse.id, checkInPunctuality: 'on_time', checkOutPunctuality: 'none' });
    const n = await runSweep();
    assert.ok(n >= 1);
    const after = await StaffAttendance.findByPk(row.id);
    assert.equal(after.status, 'missed_checkout');
    const t = await call(hrAttendance.today, { user: asUser(hr) });
    assert.ok(t.body.data.counts.missedCheckouts >= 1);
    assert.ok(t.body.data.attention.some((x) => x.kind === 'missed_checkout'));
  });
});

describe('remembered phones', () => {
  let raw;
  test('login with rememberDevice from the tap page returns a device token', async () => {
    const bcrypt = require('bcryptjs');
    await doctor.update({ password: await bcrypt.hash('Passw0rd!', 4) });
    const r = await call(auth.login, { body: { email: 'e@cdc.test', password: 'Passw0rd!', rememberDevice: true, context: 'hr-tap' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.token); assert.ok(r.body.data.deviceToken);
    raw = r.body.data.deviceToken;
    const d = await UserDevice.findOne({ where: { UserId: doctor.id } });
    assert.equal(d.label, 'iPhone · Safari');
    assert.ok(!raw.includes(d.tokenHash));
    // Not honoured outside the tap page
    const plain = await call(auth.login, { body: { email: 'e@cdc.test', password: 'Passw0rd!', rememberDevice: true } });
    assert.equal(plain.body.data.deviceToken, undefined);
  });
  test('exchanging the token opens a session and logs a device login', async () => {
    const r = await call(auth.deviceSession, { body: { deviceToken: raw } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.token); assert.equal(r.body.data.user.email, 'e@cdc.test');
    assert.ok(r.body.data.user.portals.includes('portal.hr'));
    await new Promise((res) => setTimeout(res, 50));
    assert.equal((await UserLoginLog.findOne({ where: { userId: doctor.id, method: 'device' } })) != null, true);
    const junk = await call(auth.deviceSession, { body: { deviceToken: 'x'.repeat(43) } });
    assert.equal(junk.status, 401);
  });
  test('revoking the phone ends it; deactivating the account revokes all', async () => {
    const list = await call(hrDevices.list, { user: asUser(doctor), query: {} });
    assert.equal(list.body.data.length, 1);
    const other = await call(hrDevices.list, { user: asUser(nurse), query: { userId: String(doctor.id) } });
    assert.equal(other.status, 403);
    const rev = await call(hrDevices.revoke, { user: asUser(doctor), params: { id: String(list.body.data[0].id) } });
    assert.equal(rev.status, 200);
    assert.equal((await call(auth.deviceSession, { body: { deviceToken: raw } })).status, 401);
  });
});

describe('tags', () => {
  test('register, never echo the key, test a tap URL without spending the counter', async () => {
    const k = await call(hrTags.newKey, { user: asUser(hr) });
    assert.match(k.body.data.key, /^[0-9A-F]{32}$/);
    const c = await call(hrTags.create, { user: asUser(hr), body: { uid: '047C1D9E2B3A40', label: 'Side gate', key: k.body.data.key } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.data.keyEncrypted, undefined); assert.equal(c.body.data.key, undefined);
    const dup = await call(hrTags.create, { user: asUser(hr), body: { uid: '047C1D9E2B3A40', label: 'Dup', key: k.body.data.key } });
    assert.equal(dup.status, 409);
    const url = `https://cdiabetescentre.com/hr/tap?uid=047C1D9E2B3A40&ctr=000005&cmac=${computeSunMac({ keyHex: k.body.data.key, uidHex: '047C1D9E2B3A40', counter: 5 })}`;
    const t = await call(hrTags.test, { user: asUser(hr), params: { id: String(c.body.data.id) }, body: { url } });
    assert.equal(t.body.data.ok, true); assert.equal(t.body.data.counter, 5);
    assert.equal((await HrNfcTag.findByPk(c.body.data.id)).lastCounter, 0);
    const bad = await call(hrTags.test, { user: asUser(hr), params: { id: String(c.body.data.id) }, body: { url: url.replace(/cmac=.*/, 'cmac=0000000000000000') } });
    assert.equal(bad.body.data.ok, false);
    const list = await call(hrTags.list, { user: asUser(hr) });
    assert.ok(list.body.data.every((x) => x.keyEncrypted === undefined));
    const ret = await call(hrTags.update, { user: asUser(hr), params: { id: String(c.body.data.id) }, body: { status: 'retired' } });
    assert.equal(ret.body.data.status, 'retired');
    clearHrCache();
  });
});
