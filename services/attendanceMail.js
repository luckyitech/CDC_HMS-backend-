// =====================================================================
// Attendance emails to staff (1 Nov 2026, Emu).
//
//   sendStarMail     the same day, on arrival: a gold star (in before the
//                    clinic opens) gets a thank-you; a red star (in late) gets
//                    a kind note. Once per person per day; never for times HR
//                    entered or for past days (services/punchService decides).
//   runWeeklyIfDue   every Saturday from 14:00 (after closing): each person's
//                    Monday–Saturday — hours worked, gold and red stars, late
//                    arrivals, early check-outs, missed check-outs.
//
// Both go through services/hrNotify, so they reach the bell and email, and
// HR can switch either channel off under Alerts & reminders (events
// 'attendance_star', 'attendance_weekly'). Best-effort: a failure is logged
// and never affects attendance.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { notify } = require('./hrNotify');
const { clinicToday, clinicDateTime } = require('../utils/clinicTime');
const { clinicHHMM, expectedAtWork } = require('../utils/attendanceRules');
const { weekdayOf } = require('../utils/workHours');

const { Setting, StaffAttendance } = db;

const LINK = '/hr/dashboard';
/** 'YYYY-MM-DD' + n days (calendar arithmetic, no time zone). */
const plusDays = (date, n) => {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const hm = (minutes) => {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayName = (date) => `${DAY[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${MONTH[Number(date.slice(5, 7)) - 1].slice(0, 3)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The same-day star email. `star` is 'gold' or 'red' (arrival only).
 * @returns {Promise<object|null>} hrNotify's result
 */
const sendStarMail = async ({ userId, firstName, star, at, expectedAt, minutes }) => {
  const time = clinicHHMM(at);
  const opens = expectedAt ? clinicHHMM(expectedAt) : '08:00';
  // Minutes from the opening time itself (any HR grace is not subtracted).
  if (expectedAt) minutes = Math.abs(Math.round((new Date(at) - new Date(expectedAt)) / 60000));
  const name = firstName ? `, ${firstName}` : '';
  if (star === 'gold') {
    return notify('attendance_star', {
      recipients: [userId],
      title: 'A gold star today — thank you',
      body: `Well done${name}! You checked in at ${time} today, ${plural(minutes, 'minute')} before we open at ${opens}.\n\nArriving early makes a real difference to our patients and to the team. Thank you.`,
      link: LINK,
    });
  }
  if (star === 'red') {
    return notify('attendance_star', {
      recipients: [userId],
      title: 'A red star today — late arrival',
      body: `You checked in at ${time} today, ${plural(minutes, 'minute')} after we open at ${opens}.\n\nIf something held you up, please let HR know. We look forward to seeing you on time tomorrow.`,
      link: LINK,
    });
  }
  return null;
};

/** This week's Monday–Saturday for a clinic date (the Saturday it is sent on). */
const weekOf = (clinicDate) => {
  const wd = weekdayOf(clinicDate);                 // 0 Sun … 6 Sat
  const monday = plusDays(clinicDate, -((wd + 6) % 7));
  return Array.from({ length: 6 }, (_, i) => plusDays(monday, i));
};

/** The weekly email's words for one person — pure, from periodSummaryFor's result. */
const weeklyText = ({ firstName, dates, summary, now = new Date() }) => {
  const { table, stars, days, sessions } = summary;
  const gold = stars.all.gold;
  const red = stars.all.red;
  const byDate = new Map();
  for (const s of sessions) if (!byDate.has(s.clinicDate)) byDate.set(s.clinicDate, s);

  const late = sessions.filter((s) => s.checkInPunctuality === 'late')
    .map((s) => `${dayName(s.clinicDate)} — in at ${clinicHHMM(s.checkInAt)} (${plural(s.lateMinutes || 0, 'minute')} late)`);
  const early = sessions.filter((s) => s.checkOutPunctuality === 'early')
    .map((s) => `${dayName(s.clinicDate)} — out at ${clinicHHMM(s.checkOutAt)} (${plural(s.earlyOutMinutes || 0, 'minute')} early)`);
  // Saturday's email goes at 14:00, before the midnight sweep: a day whose
  // closing time has passed with no check-out counts as missed here too, and
  // its time inside up to the last out is counted.
  const endedOpen = sessions.filter((s) => s.status === 'open' && s.expectedOutAt && new Date(s.expectedOutAt) <= now);
  const missed = sessions.filter((s) => s.status === 'missed_checkout' || endedOpen.includes(s)).map((s) => dayName(s.clinicDate));
  const hours = table.hoursWorkedMinutes + endedOpen.reduce((n, s) => n + (s.workedMinutes || 0), 0);
  const away = sessions.reduce((n, s) => n + (s.awayMinutes || 0), 0);
  const closed = days.filter((d) => d.holiday).map((d) => `${dayName(d.date)} (${d.holiday})`);
  const leave = days.filter((d) => d.onLeave).map((d) => dayName(d.date));

  const lines = [
    `Your week, ${dayName(dates[0])} – ${dayName(dates[dates.length - 1])}:`,
    '',
    `Hours worked: ${hm(hours)} of ${hm(table.expectedMinutes)} expected${away ? ` (time out: ${hm(away)})` : ''}`,
    `Days in: ${table.workingDays.worked} of ${table.workingDays.total}`,
    `Gold stars: ${gold}`,
    `Red stars: ${red}`,
    `Late arrivals: ${late.length ? late.length : 'none'}`,
    ...late.map((l) => `  • ${l}`),
    `Early check-outs: ${early.length ? early.length : 'none'}`,
    ...early.map((l) => `  • ${l}`),
  ];
  if (missed.length) lines.push(`Missed check-outs: ${missed.length} — ${missed.join(', ')} (please tell HR your leaving time)`);
  if (leave.length) lines.push(`On leave: ${leave.join(', ')}`);
  if (closed.length) lines.push(`Clinic closed: ${closed.join(', ')}`);
  lines.push('');
  if (red === 0 && !missed.length && table.workingDays.worked > 0) {
    lines.push(gold > 0 ? `An excellent week${firstName ? `, ${firstName}` : ''} — thank you!` : 'A punctual week — thank you!');
  } else {
    lines.push('Thank you for your work this week. Remember to punch every time you go in or out.');
  }
  return {
    title: `Your week at CDC — ${hm(hours)} hours, ${gold} gold, ${red} red`,
    body: lines.join('\n'),
  };
};

const SENT_KEY = 'hr.attendance.weeklySentFor';
const SEND_FROM = '14:00';
const RECENT_DAYS = 28;

/** The Saturday whose week was last due on `today` at `time` (for the first run). */
const lastDueSaturday = (today, time) => {
  const wd = weekdayOf(today);
  if (wd === 6 && time >= SEND_FROM) return today;
  return plusDays(today, -((wd + 1) % 7 || 7));
};

const readMarker = (row) => {
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    if (v && typeof v === 'object' && v.week) return { week: v.week, done: Array.isArray(v.done) ? v.done : [], complete: !!v.complete };
  } catch { /* an older plain value */ }
  return { week: String(row.value), done: [], complete: true };
};

/**
 * Send the weekly email when due: Saturday from 14:00, or Sunday if the
 * server was down on Saturday afternoon.
 *
 * Once per week, resumable: the Setting row keeps the week and who has been
 * sent it, saved after each person — a restart or a failure part-way carries
 * on with the rest at the next tick (every 5 minutes) instead of losing the
 * week or sending anyone a second copy. The very first run (no row yet)
 * records the week just gone as done and sends nothing, so a deploy never
 * sends last week's email out of the blue.
 *
 * To everyone expected at work (doctors included, not the admin account) who
 * checked in at least once in the last four weeks — so test and departed
 * accounts are left out.
 * @returns {Promise<number>} people sent it this run
 */
const runWeeklyIfDue = async (now = new Date(), { force = false } = {}) => {
  const today = clinicToday(now);
  const wd = weekdayOf(today);
  const time = clinicDateTime(now).slice(11, 16);

  let row = await Setting.findOne({ where: { key: SENT_KEY } });
  if (!row && !force) {
    const week = weekOf(lastDueSaturday(today, time))[0];
    await Setting.create({ key: SENT_KEY, value: JSON.stringify({ week, done: [], complete: true }) });
    return 0;
  }
  if (!force && !((wd === 6 && time >= SEND_FROM) || wd === 0)) return 0;
  const saturday = wd === 0 ? plusDays(today, -1) : today;
  const dates = weekOf(saturday);
  let state = readMarker(row);
  if (!force && state && state.week === dates[0] && state.complete) return 0;
  if (!state || state.week !== dates[0] || force) state = { week: dates[0], done: [], complete: false };

  const svc = require('./hrAttendanceService');
  const { getHrConfig } = require('../utils/hrConfig');
  const cfg = await getHrConfig();
  const since = plusDays(saturday, -RECENT_DAYS);
  const recent = new Set((await StaffAttendance.findAll({
    where: { clinicDate: { [Op.between]: [since, saturday] }, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } },
    attributes: ['UserId'], group: ['UserId'], raw: true,
  })).map((r) => r.UserId));
  const people = (await svc.internalUsers()).filter((u) => expectedAtWork(u) && recent.has(u.id) && u.email && !state.done.includes(u.id));

  const save = async () => {
    const value = JSON.stringify(state);
    if (row) await row.update({ value });
    else row = await Setting.create({ key: SENT_KEY, value });
  };

  let sent = 0;
  for (const u of people) {
    const summary = await svc.periodSummaryFor(u.id, dates, cfg, { now });
    const { title, body } = weeklyText({ firstName: u.firstName, dates, summary, now });
    await notify('attendance_weekly', { recipients: [u.id], title, body, link: LINK });
    state.done.push(u.id);
    await save();
    sent += 1;
  }
  state.complete = true;
  await save();
  console.log(`[HR] weekly attendance email: ${sent} sent for week of ${dates[0]} (${state.done.length} in all)`);
  return sent;
};

module.exports = { sendStarMail, runWeeklyIfDue, weeklyText, weekOf };
