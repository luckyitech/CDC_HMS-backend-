// =====================================================================
// Shift roster — the rules (HR Tier 3 Phase 4; mockup D; Emu 3 Oct 2026:
// T3-5 a, T3-6 a, T3-7 a; build defaults RO-1…RO-12). Pure: no database.
//
//   - Who is on a roster: nurses, lab and front office (role 'staff') — doctors
//     keep their appointment schedule and blocks (T3-6 a).
//   - Shift types are HR's clinic-wide list (name, start, end, colour). A shift
//     whose end is at or before its start runs past midnight (RO-1).
//   - A cell is a shift (from a type, its times COPIED onto the cell so a later
//     edit of the type never rewrites a week) or "Off" (RO-6). Blank = not
//     rostered: the person's usual working hours apply.
//   - Warnings only, never blocks (T3-7 a, RO-8): rest under 11 h between two
//     shifts; a day's cover under the week's minimum; a shift on approved leave.
//   - A published cell becomes that person's DATED working hours for the day
//     (T3-5 a) — workHoursOf() is the one translation.
// =====================================================================

const { HHMM, spanMinutes, atClinicTime, nextDate } = require('./workHours');

const ROSTER_ROLES = ['nurse', 'lab', 'staff'];
const REST_HOURS = 11;
const COLOURS = ['blue', 'green', 'indigo', 'amber', 'rose', 'teal', 'violet', 'slate'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (iso, n) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The Monday on or before a date ('YYYY-MM-DD'). */
const mondayOf = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(iso, wd === 0 ? -6 : 1 - wd);
};

const isMonday = (iso) => DATE.test(iso || '') && mondayOf(iso) === iso;

/** The seven dates of the week starting on a Monday. */
const weekDates = (weekStart) => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

const isRosterRole = (role) => ROSTER_ROLES.includes(role);

/**
 * Clean a shift type from the client.
 * @returns {{ value } | { error }}
 */
const cleanShiftType = (input = {}, { partial = false } = {}) => {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'NAME_REQUIRED' };
    if (name.length > 40) return { error: 'NAME_TOO_LONG' };
    out.name = name;
  }
  for (const key of ['startTime', 'endTime']) {
    if (!partial || input[key] !== undefined) {
      const t = String(input[key] ?? '').slice(0, 5);
      if (!HHMM.test(t)) return { error: 'BAD_TIME' };
      out[key] = t;
    }
  }
  if (out.startTime && out.endTime && out.startTime === out.endTime) return { error: 'SAME_TIME' };
  if (!partial || input.colour !== undefined) {
    const c = input.colour == null || input.colour === '' ? 'blue' : String(input.colour);
    if (!COLOURS.includes(c)) return { error: 'BAD_COLOUR' };
    out.colour = c;
  }
  if (input.sortOrder !== undefined) {
    const n = Number(input.sortOrder);
    if (!Number.isInteger(n)) return { error: 'BAD_ORDER' };
    out.sortOrder = n;
  }
  if (input.status !== undefined) {
    if (!['active', 'archived'].includes(input.status)) return { error: 'BAD_STATUS' };
    out.status = input.status;
  }
  return { value: out };
};

/** A cell's length in minutes (0 for Off). */
const minutesOf = (cell) => (cell && !cell.isOff ? spanMinutes(cell.startTime, cell.endTime) : 0);

/** Does this shift run past midnight? */
const isOvernight = (cell) => !!cell && !cell.isOff && !!cell.startTime && !!cell.endTime && cell.endTime <= cell.startTime;

/** The dated working-hours row a published cell becomes (T3-5 a). */
const workHoursOf = (cell) => (cell.isOff
  ? { startTime: null, endTime: null, isOff: true }
  : { startTime: cell.startTime, endTime: cell.endTime, isOff: false });

/** The instants a shift runs between, in the clinic's time. */
const spanOf = (cell) => {
  if (!cell || cell.isOff || !cell.startTime || !cell.endTime) return null;
  const start = atClinicTime(cell.date, cell.startTime);
  const end = atClinicTime(isOvernight(cell) ? nextDate(cell.date) : cell.date, cell.endTime);
  return { start, end };
};

/**
 * Warnings for a week (RO-8). Never blocks anything.
 *
 * @param {object} p
 * @param {string[]} p.dates      the week's seven dates
 * @param {Array}    p.cells      [{ UserId, date, isOff, startTime, endTime }] — the week's
 *                                cells, plus any from the day before (for rest)
 * @param {Set}      p.leave      'userId|date' keys on approved leave
 * @param {number}   p.minCover   people on shift wanted per day (0 = no check)
 * @param {number[]} [p.people]   the people the grid shows (cover counts only them)
 * @returns {Array<{kind:'rest'|'cover'|'leave', userId?, date, hours?, count?, min?}>}
 */
const warningsFor = ({ dates, cells = [], leave = new Set(), minCover = 0, people = null }) => {
  const out = [];
  const inWeek = new Set(dates);
  const shown = people ? new Set(people.map(Number)) : null;

  // Rest between consecutive shifts of one person.
  const byPerson = new Map();
  for (const c of cells) {
    if (c.isOff) continue;
    const span = spanOf(c);
    if (!span) continue;
    const list = byPerson.get(Number(c.UserId)) || [];
    list.push({ ...c, span });
    byPerson.set(Number(c.UserId), list);
  }
  for (const [userId, list] of byPerson) {
    list.sort((a, b) => a.span.start - b.span.start);
    for (let i = 1; i < list.length; i++) {
      const gapH = (list[i].span.start - list[i - 1].span.end) / 3600000;
      if (gapH < REST_HOURS && inWeek.has(list[i].date)) {
        out.push({ kind: 'rest', userId, date: list[i].date, hours: Math.max(0, Math.round(gapH * 10) / 10) });
      }
    }
  }

  // A shift on approved leave.
  for (const c of cells) {
    if (c.isOff || !inWeek.has(c.date)) continue;
    if (leave.has(`${Number(c.UserId)}|${c.date}`)) out.push({ kind: 'leave', userId: Number(c.UserId), date: c.date });
  }

  // Cover per day.
  const min = Number(minCover) || 0;
  if (min > 0) {
    for (const date of dates) {
      const count = cells.filter((c) => c.date === date && !c.isOff && (!shown || shown.has(Number(c.UserId)))).length;
      if (count < min) out.push({ kind: 'cover', date, count, min });
    }
  }
  return out;
};

/**
 * What "Copy last week" writes (RO-9): last week's cells moved on 7 days, only
 * into EMPTY cells, only today or later, never onto a leave day.
 * @returns [{ UserId, date, shiftTypeId, isOff, startTime, endTime }]
 */
const copyPlan = ({ previous = [], existing = [], today, leave = new Set(), people }) => {
  const taken = new Set(existing.map((c) => `${Number(c.UserId)}|${c.date}`));
  const allowed = people ? new Set(people.map(Number)) : null;
  const out = [];
  for (const c of previous) {
    const date = addDays(c.date, 7);
    const key = `${Number(c.UserId)}|${date}`;
    if (date < today || taken.has(key) || leave.has(key)) continue;
    if (allowed && !allowed.has(Number(c.UserId))) continue;
    out.push({ UserId: Number(c.UserId), date, shiftTypeId: c.shiftTypeId ?? null, isOff: !!c.isOff, startTime: c.startTime ?? null, endTime: c.endTime ?? null });
  }
  return out;
};

module.exports = {
  ROSTER_ROLES, REST_HOURS, COLOURS,
  addDays, mondayOf, isMonday, weekDates, isRosterRole,
  cleanShiftType, minutesOf, isOvernight, workHoursOf, spanOf, warningsFor, copyPlan,
};
