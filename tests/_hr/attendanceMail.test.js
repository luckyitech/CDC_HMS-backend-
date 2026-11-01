// Attendance emails and the clinic's fixed hours/holidays (1 Nov 2026, Emu).
// Real DB (throwaway); hrNotify.notify is replaced by a recorder BEFORE the
// attendance mail service loads, so nothing is emailed.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });

require('../_guard').assertThrowawayDb('hr attendance mail test');

const sent = [];
const hrNotify = require('../../services/hrNotify');
hrNotify.notify = async (event, p) => { sent.push({ event, ...p }); return { bell: 1, email: 1, whatsapp: 0 }; };

const db = require('../../models');
const { setHrConfig } = require('../../utils/hrConfig');
const punchSvc = require('../../services/punchService');
const { getHrConfig } = require('../../utils/hrConfig');
const mail = require('../../services/attendanceMail');
const { ensureYearHolidays, clearHolidayCache } = require('../../services/leaveService');
const { expectedFor } = require('../../services/hrAttendanceService');

const { User, StaffProfile, StaffPunch, StaffAttendance, Setting, PublicHoliday, StaffWorkHours } = db;

let mildred, rahma, ghost;
const at = (d, t) => new Date(`${d}T${t}:00+03:00`);
const MON = '2026-11-02';
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
const punchDay = async (u, d, times, now) => {
  for (const t of times) await StaffPunch.create({ UserId: u.id, clinicDate: d, at: at(d, t), source: 'fingerprint', outcome: 'applied' });
  return punchSvc.rebuildDay({ userId: u.id, clinicDate: d, cfg: await getHrConfig(), now });
};
const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  await db.sequelize.authenticate();
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=0');
  for (const m of [StaffPunch, StaffAttendance, StaffWorkHours, StaffProfile, User, Setting, PublicHoliday]) {
    await m.destroy({ where: {}, truncate: true });
  }
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=1');
  mildred = await User.create({ firstName: 'Mildred', lastName: 'Omari', email: 'm@cdc.test', password: 'x', role: 'staff', isActive: true });
  rahma = await User.create({ firstName: 'Rahma', lastName: 'Wanjiru', email: 'r@cdc.test', password: 'x', role: 'doctor', isActive: true });
  ghost = await User.create({ firstName: 'Test', lastName: 'Account', email: 't@cdc.test', password: 'x', role: 'staff', isActive: true });
  for (const [u, n] of [[mildred, 7], [rahma, 8], [ghost, 1]]) await StaffProfile.create({ UserId: u.id, employeeId: `EMP00${n}` });
  await setHrConfig({ debounceSeconds: 120, minSessionMinutes: 10, graceMinutes: 0 });
});
after(async () => { await db.sequelize.close(); });

describe('clinic hours and holidays — nothing for HR to set', () => {
  test('everyone on 08:00–17:00 / Sat 08:00–13:00 / Sunday off, whatever HR set before', async () => {
    await StaffWorkHours.create({ UserId: mildred.id, weekday: 1, startTime: '10:00:00', endTime: '14:00:00', status: 'active' });
    const cfg = await getHrConfig();
    const mon = await expectedFor(mildred.id, '2026-11-02', cfg);
    const sat = await expectedFor(mildred.id, '2026-11-07', cfg);
    const sun = await expectedFor(mildred.id, '2026-11-08', cfg);
    assert.deepEqual([mon.start, mon.end, sat.start, sat.end, sun.start], ['08:00', '17:00', '08:00', '13:00', null]);
  });

  test('a year\'s holidays fill themselves in; a moved Idd day is not put back', async () => {
    const added = await ensureYearHolidays(2027);
    assert.ok(added >= 12, String(added));
    const names = (await PublicHoliday.findAll({ where: { date: { [db.Sequelize.Op.between]: ['2027-01-01', '2027-12-31'] } } })).map((h) => `${String(h.date).slice(0, 10)} ${h.name}`);
    assert.ok(names.includes('2027-03-26 Good Friday'));
    assert.ok(names.includes('2027-03-29 Easter Monday'));
    assert.ok(names.some((n) => n.startsWith('2027-03-09 Idd-ul-Fitr')));
    assert.ok(names.includes('2027-12-13 Jamhuri Day (observed)'), names.join(' | '));   // 12 Dec 2027 is a Sunday
    // HR moves Idd-ul-Fitr to the declared day: retire the estimate, add the declared one.
    const est = await PublicHoliday.findOne({ where: { date: '2027-03-09' } });
    await est.update({ status: 'retired' });
    await PublicHoliday.create({ date: '2027-03-10', name: 'Idd-ul-Fitr', status: 'active', source: 'hr' });
    assert.equal(await ensureYearHolidays(2027), 0);
    assert.equal((await PublicHoliday.findOne({ where: { date: '2027-03-09' } })).status, 'retired');
  });

  test('on a public holiday nobody is expected in', async () => {
    await ensureYearHolidays(2026);
    clearHolidayCache();
    const exp = await expectedFor(mildred.id, '2026-12-25', await getHrConfig());
    assert.equal(exp.start, null);
    assert.equal(exp.source, 'holiday');
  });
});

describe('the same-day star email', () => {
  test('gold arrival today → one thank-you; a later punch the same day sends nothing more', async () => {
    sent.length = 0;
    await punchDay(mildred, MON, ['07:48'], at(MON, '07:49'));
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'attendance_star');
    assert.deepEqual(sent[0].recipients, [mildred.id]);
    assert.match(sent[0].title, /gold star/i);
    assert.match(sent[0].body, /07:48.*12 minutes before/);
    await punchDay(mildred, MON, ['17:05'], at(MON, '17:06'));
    await settle();
    assert.equal(sent.length, 1);
  });

  test('red arrival today → one late note', async () => {
    sent.length = 0;
    await punchDay(rahma, MON, ['08:14'], at(MON, '08:15'));
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /red star/i);
    assert.match(sent[0].body, /08:14.*14 minutes after/);
  });

  test('on time, a past day, or a time HR entered → no star email', async () => {
    sent.length = 0;
    await punchDay(ghost, '2026-11-03', ['08:00'], at('2026-11-03', '08:01'));          // on time (green)
    await punchDay(rahma, '2026-10-30', ['07:30'], at(MON, '09:00'));                   // a past day, gold
    await settle();
    assert.equal(sent.length, 0);
  });
});

describe('the weekly email', () => {
  test('Saturday 14:00: hours, stars, late days and early outs; once only; test accounts with no punches left out', async () => {
    // Mildred: Mon gold in + lunch out; Tue late, Wed leaves early; rest on time.
    await punchDay(mildred, MON, ['12:30', '13:30'], at(MON, '18:00'));
    await punchDay(mildred, '2026-11-03', ['08:20', '17:00'], at('2026-11-03', '18:00'));
    await punchDay(mildred, '2026-11-04', ['08:00', '16:00'], at('2026-11-04', '18:00'));
    await punchDay(mildred, '2026-11-05', ['08:00', '17:00'], at('2026-11-05', '18:00'));
    await punchDay(mildred, '2026-11-06', ['08:00', '17:00'], at('2026-11-06', '18:00'));
    await punchDay(mildred, '2026-11-07', ['08:00', '13:00'], at('2026-11-07', '14:00'));
    await StaffAttendance.destroy({ where: { UserId: ghost.id } });
    sent.length = 0;

    assert.equal(await mail.runWeeklyIfDue(at('2026-11-07', '13:59')), 0);          // not yet
    const n = await mail.runWeeklyIfDue(at('2026-11-07', '14:05'));
    assert.equal(n, 2);                                                               // Mildred and Rahma (doctor); not the test account
    const m = sent.find((s) => s.recipients[0] === mildred.id);
    assert.equal(m.event, 'attendance_weekly');
    assert.match(m.body, /Mon 2 Nov – Sat 7 Nov/);
    // 07:48–17:05 less 1:00 out = 8:17; Tue 8:40; Wed 8:00; Thu 9:00; Fri 9:00; Sat 5:00 → 47:57
    assert.match(m.body, /Hours worked: 47:57 of 50:00 expected \(time out: 1:00\)/);
    assert.match(m.body, /Gold stars: 2/);                                            // Mon in early + Mon out late
    assert.match(m.body, /Red stars: 2/);                                             // Tue late, Wed early out
    assert.match(m.body, /Tue 3 Nov — in at 08:20 \(20 minutes late\)/);
    assert.match(m.body, /Wed 4 Nov — out at 16:00 \(60 minutes early\)/);
    assert.equal(await mail.runWeeklyIfDue(at('2026-11-07', '15:00')), 0);          // once a week
    assert.equal(await mail.runWeeklyIfDue(at('2026-11-08', '09:00')), 0);          // nor again on Sunday
  });

  test('weeklyText: a week with no red star says thank you', () => {
    const summary = {
      table: { hoursWorkedMinutes: 2700, expectedMinutes: 2700, workingDays: { worked: 6, total: 6 } },
      stars: { all: { gold: 3, red: 0 } }, days: [], sessions: [],
    };
    const { title, body } = mail.weeklyText({ firstName: 'Bridgit', dates: WEEK, summary });
    assert.match(title, /45:00 hours, 3 gold, 0 red/);
    assert.match(body, /An excellent week, Bridgit/);
  });
});
