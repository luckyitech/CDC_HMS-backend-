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
const weeklyText = ({ firstName, dates, summary }) => {
  const { table, stars, days, sessions } = summary;
  const gold = stars.all.gold;
  const red = stars.all.red;
  const byDate = new Map();
  for (const s of sessions) if (!byDate.has(s.clinicDate)) byDate.set(s.clinicDate, s);

  const late = sessions.filter((s) => s.checkInPunctuality === 'late')
    .map((s) => `${dayName(s.clinicDate)} — in at ${clinicHHMM(s.checkInAt)} (${plural(s.lateMinutes || 0, 'minute')} late)`);
  const early = sessions.filter((s) => s.checkOutPunctuality === 'early')
    .map((s) => `${dayName(s.clinicDate)} — out at ${clinicHHMM(s.checkOutAt)} (${plural(s.earlyOutMinutes || 0, 'minute')} early)`);
  const missed = sessions.filter((s) => s.status === 'missed_checkout').map((s) => dayName(s.clinicDate));
  const away = sessions.reduce((n, s) => n + (s.awayMinutes || 0), 0);
  const closed = days.filter((d) => d.holiday).map((d) => `${dayName(d.date)} (${d.holiday})`);
  const leave = days.filter((d) => d.onLeave).map((d) => dayName(d.date));

  const lines = [
    `Your week, ${dayName(dates[0])} – ${dayName(dates[dates.length - 1])}:`,
    '',
    `Hours worked: ${hm(table.hoursWorkedMinutes)} of ${hm(table.expectedMinutes)} expected${away ? ` (time out: ${hm(away)})` : ''}`,
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
    title: `Your week at CDC — ${hm(table.hoursWorkedMinutes)} hours, ${gold} gold, ${red} red`,
    body: lines.join('\n'),
  };
};

const SENT_KEY = 'hr.attendance.weeklySentFor';
const SEND_FROM = '14:00';
const RECENT_DAYS = 28;

/**
 * Send the weekly email when due: Saturday from 14:00, or Sunday if the
 * server was down on Saturday afternoon. Once per week (the Monday is kept
 * in the Setting table before anything is sent, so a restart never sends it
 * twice). To everyone expected at work (doctors included, not the admin
 * account) who checked in at least once in the last four weeks — so test and
 * departed accounts are left out.
 * @returns {Promise<number>} people emailed
 */
const runWeeklyIfDue = async (now = new Date(), { force = false } = {}) => {
  const today = clinicToday(now);
  const wd = weekdayOf(today);
  const time = clinicDateTime(now).slice(11, 16);
  if (!force && !((wd === 6 && time >= SEND_FROM) || wd === 0)) return 0;
  const saturday = wd === 0 ? plusDays(today, -1) : today;
  const dates = weekOf(saturday);

  const marker = await Setting.findOne({ where: { key: SENT_KEY } });
  if (!force && marker && marker.value === dates[0]) return 0;
  if (marker) await marker.update({ value: dates[0] });
  else await Setting.create({ key: SENT_KEY, value: dates[0] });

  const svc = require('./hrAttendanceService');
  const { getHrConfig } = require('../utils/hrConfig');
  const cfg = await getHrConfig();
  const since = plusDays(saturday, -RECENT_DAYS);
  const recent = new Set((await StaffAttendance.findAll({
    where: { clinicDate: { [Op.between]: [since, saturday] }, status: { [Op.in]: ['open', 'closed', 'missed_checkout'] } },
    attributes: ['UserId'], group: ['UserId'], raw: true,
  })).map((r) => r.UserId));
  const people = (await svc.internalUsers()).filter((u) => expectedAtWork(u) && recent.has(u.id) && u.email);

  let sent = 0;
  for (const u of people) {
    try {
      const summary = await svc.periodSummaryFor(u.id, dates, cfg, { now });
      const { title, body } = weeklyText({ firstName: u.firstName, dates, summary });
      const r = await notify('attendance_weekly', { recipients: [u.id], title, body, link: LINK });
      if (r && (r.email || r.bell)) sent += 1;
    } catch (err) {
      console.error('attendanceMail.weekly error:', err.message);
    }
  }
  console.log(`[HR] weekly attendance email: ${sent} of ${people.length} for week of ${dates[0]}`);
  return sent;
};

module.exports = { sendStarMail, runWeeklyIfDue, weeklyText, weekOf };
