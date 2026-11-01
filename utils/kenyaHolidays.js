// =====================================================================
// Kenya's public holidays for a year — pure (1 Nov 2026, Emu: closed on
// public holidays, nothing for HR to set up).
//
//   Fixed (Public Holidays Act, Cap. 110): New Year's Day, Labour Day,
//   Madaraka Day, Mazingira Day (10 Oct), Mashujaa Day, Jamhuri Day,
//   Christmas Day, Boxing Day.
//   Easter: Good Friday, Easter Monday (Gregorian computus).
//   Idd-ul-Fitr and Idd-ul-Adha: declared each year when the moon is sighted.
//   The expected date comes from the Umm al-Qura calendar built into Node
//   (1 Shawwal, 10 Dhul-Hijjah). It matched Kenya's 20 Mar 2026 Idd-ul-Fitr;
//   when a declaration differs, HR moves the day on the holidays list.
//
// A holiday on a Sunday is also observed on the next day — that rule already
// lives in services/leaveService syncObservedDays.
// =====================================================================

const FIXED = [
  ['01-01', "New Year's Day"],
  ['05-01', 'Labour Day'],
  ['06-01', 'Madaraka Day'],
  ['10-10', 'Mazingira Day'],
  ['10-20', 'Mashujaa Day'],
  ['12-12', 'Jamhuri Day'],
  ['12-25', 'Christmas Day'],
  ['12-26', 'Boxing Day'],
];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** Easter Sunday (Gregorian), anonymous computus. */
const easterSunday = (y) => {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
};

/** The Gregorian dates in `y` of an Islamic month/day (Umm al-Qura). Usually one. */
let hijriFmt = null;
const hijriDates = (y, hMonth, hDay) => {
  if (!hijriFmt) {
    hijriFmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  }
  const out = [];
  for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = addDays(d, 1)) {
    const parts = hijriFmt.formatToParts(d);
    const m = Number(parts.find((p) => p.type === 'month')?.value);
    const dd = Number(parts.find((p) => p.type === 'day')?.value);
    if (m === hMonth && dd === hDay) out.push(iso(d));
  }
  return out;
};

const IDD = [
  { key: 'fitr', name: 'Idd-ul-Fitr', month: 10, day: 1, matches: /(idd|eid).*(fitr)/i },
  { key: 'adha', name: 'Idd-ul-Adha', month: 12, day: 10, matches: /(idd|eid).*(adha|azha|hajj)/i },
];

/**
 * Every public holiday of a year, sorted.
 * @returns {Array<{ date:string, name:string, kind:'fixed'|'easter'|'idd', iddKey?:string }>}
 */
const kenyaHolidays = (y) => {
  const list = FIXED.map(([md, name]) => ({ date: `${y}-${md}`, name, kind: 'fixed' }));
  const easter = easterSunday(y);
  list.push({ date: iso(addDays(easter, -2)), name: 'Good Friday', kind: 'easter' });
  list.push({ date: iso(addDays(easter, 1)), name: 'Easter Monday', kind: 'easter' });
  for (const idd of IDD) {
    for (const date of hijriDates(y, idd.month, idd.day)) {
      list.push({ date, name: idd.name, kind: 'idd', iddKey: idd.key });
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
};

module.exports = { kenyaHolidays, easterSunday, IDD };
