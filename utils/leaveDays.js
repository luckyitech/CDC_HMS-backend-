// Counting leave days.
//
// Split out from the controller because it is the one piece of leave logic with
// a right and a wrong answer, and it needs to be testable without a database.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parses a YYYY-MM-DD string into a UTC date.
//
// UTC deliberately: `new Date('2026-08-03')` is midnight UTC, but
// `new Date(2026, 7, 3)` is midnight local. Mixing the two makes a day-count
// come out one short whenever a daylight-saving boundary falls inside the
// range, and that error only shows up twice a year.
const toUtcDate = (value) => {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const isWeekend = (date) => {
  const day = date.getUTCDay();
  return day === 0 || day === 6;   // Sunday or Saturday
};

/**
 * Number of leave days between two dates, inclusive of both ends.
 *
 * Inclusive because leave from Monday to Friday is five days, not four —
 * a plain date subtraction gives four and quietly under-charges every request.
 *
 * @param {string|Date} startDate
 * @param {string|Date} endDate
 * @param {{ excludeWeekends?: boolean }} options
 * @returns {number} 0 if the range is invalid or reversed
 */
const countLeaveDays = (startDate, endDate, { excludeWeekends = false } = {}) => {
  const start = toUtcDate(startDate);
  const end   = toUtcDate(endDate);

  if (isNaN(start) || isNaN(end) || end < start) return 0;

  if (!excludeWeekends) {
    return Math.round((end - start) / MS_PER_DAY) + 1;
  }

  let days = 0;
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + MS_PER_DAY)) {
    if (!isWeekend(d)) days += 1;
  }
  return days;
};

/**
 * Every calendar date in the range, as YYYY-MM-DD strings.
 * Used to write one DoctorBlock row per day of approved leave.
 */
const datesInRange = (startDate, endDate) => {
  const start = toUtcDate(startDate);
  const end   = toUtcDate(endDate);

  if (isNaN(start) || isNaN(end) || end < start) return [];

  const dates = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + MS_PER_DAY)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
};

/** Do two inclusive date ranges overlap? */
const rangesOverlap = (aStart, aEnd, bStart, bEnd) =>
  toUtcDate(aStart) <= toUtcDate(bEnd) && toUtcDate(bStart) <= toUtcDate(aEnd);

module.exports = { countLeaveDays, datesInRange, rangesOverlap, toUtcDate };
