const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  decide, punctuality, starFor, dayCell, streakNoRed, monthSummary, minutesBetween, clinicHHMM,
} = require('../utils/attendanceRules');

// =====================================================================
// Every branch of the tap decision table, both kinds of punctuality, the
// star mapping, and the month arithmetic — pure, no database. Nairobi has no
// DST, so instants are built at UTC+3 directly.
// =====================================================================

// A clinic-wall-clock instant: '2026-09-23 08:04' at UTC+3.
const at = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+03:00`);

const CFG = { debounceSeconds: 120, minSessionMinutes: 10, confirmCheckout: true };

describe('decide() — the tap decision table', () => {
  const now = at('2026-09-23', '17:05');

  test('no session today → checkin', () => {
    assert.equal(decide({ now, lastSession: null, cfg: CFG }), 'checkin');
  });

  test('open session, tap within the debounce → duplicate', () => {
    const s = { status: 'open', checkInAt: at('2026-09-23', '17:04') };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'duplicate');
  });

  test('open session shorter than the minimum → duplicate', () => {
    const s = { status: 'open', checkInAt: at('2026-09-23', '16:58') };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'duplicate');
  });

  test('open session, confirmation required, no confirm → offer_checkout', () => {
    const s = { status: 'open', checkInAt: at('2026-09-23', '08:04') };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'offer_checkout');
  });

  test('open session with confirm → checkout', () => {
    const s = { status: 'open', checkInAt: at('2026-09-23', '08:04') };
    assert.equal(decide({ now, lastSession: s, confirm: true, cfg: CFG }), 'checkout');
  });

  test('open session, confirmation switched off → checkout straight away', () => {
    const s = { status: 'open', checkInAt: at('2026-09-23', '08:04') };
    assert.equal(decide({ now, lastSession: s, cfg: { ...CFG, confirmCheckout: false } }), 'checkout');
  });

  test('closed session, tap right after checking out → duplicate (the same brush past the tag)', () => {
    const s = { status: 'closed', checkInAt: at('2026-09-23', '08:04'), checkOutAt: at('2026-09-23', '17:04') };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'duplicate');
  });

  test('closed session earlier in the day → a new checkin', () => {
    const s = { status: 'closed', checkInAt: at('2026-09-23', '08:04'), checkOutAt: at('2026-09-23', '13:00') };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'checkin');
  });

  test('a missed_checkout row from earlier does not block a new checkin', () => {
    const s = { status: 'missed_checkout', checkInAt: at('2026-09-22', '08:04'), checkOutAt: null };
    assert.equal(decide({ now, lastSession: s, cfg: CFG }), 'checkin');
  });
});

describe('punctuality() — check-in', () => {
  const expected = at('2026-09-23', '08:00');

  test('exactly on time', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '08:00'), expectedAt: expected, kind: 'in' }), { state: 'on_time', minutes: 0 });
  });
  test('seconds inside the same minute are still on time', () => {
    assert.equal(punctuality({ at: new Date('2026-09-23T08:00:59+03:00'), expectedAt: expected, kind: 'in' }).state, 'on_time');
  });
  test('one minute late with grace 0', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '08:01'), expectedAt: expected, kind: 'in' }), { state: 'late', minutes: 1 });
  });
  test('61 minutes late — the mockup case', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '09:01'), expectedAt: expected, kind: 'in' }), { state: 'late', minutes: 61 });
  });
  test('grace widens the on-time band and is subtracted from the minutes told', () => {
    assert.equal(punctuality({ at: at('2026-09-23', '08:05'), expectedAt: expected, graceMinutes: 5, kind: 'in' }).state, 'on_time');
    assert.deepEqual(punctuality({ at: at('2026-09-23', '08:09'), expectedAt: expected, graceMinutes: 5, kind: 'in' }), { state: 'late', minutes: 4 });
  });
  test('15 minutes early — the gold case', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '07:45'), expectedAt: expected, kind: 'in' }), { state: 'early', minutes: 15 });
  });
  test('no expected time → none', () => {
    assert.deepEqual(punctuality({ at: expected, expectedAt: null, kind: 'in' }), { state: 'none', minutes: null });
  });
});

describe('punctuality() — check-out', () => {
  const expected = at('2026-09-23', '17:00');

  test('on the dot', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '17:00'), expectedAt: expected, kind: 'out' }), { state: 'on_time', minutes: 0 });
  });
  test('40 minutes early — red', () => {
    assert.deepEqual(punctuality({ at: at('2026-09-23', '16:20'), expectedAt: expected, kind: 'out' }), { state: 'early', minutes: 40 });
  });
  test('past working hours — late, which is the GOLD star', () => {
    const p = punctuality({ at: at('2026-09-23', '17:40'), expectedAt: expected, kind: 'out' });
    assert.deepEqual(p, { state: 'late', minutes: 40 });
    assert.equal(starFor('out', p.state), 'gold');
  });
  test('grace on the way out', () => {
    assert.equal(punctuality({ at: at('2026-09-23', '16:57'), expectedAt: expected, graceMinutes: 5, kind: 'out' }).state, 'on_time');
    assert.deepEqual(punctuality({ at: at('2026-09-23', '16:50'), expectedAt: expected, graceMinutes: 5, kind: 'out' }), { state: 'early', minutes: 5 });
  });
});

describe('starFor()', () => {
  test('in: early gold, on_time green, late red, none null', () => {
    assert.equal(starFor('in', 'early'), 'gold');
    assert.equal(starFor('in', 'on_time'), 'green');
    assert.equal(starFor('in', 'late'), 'red');
    assert.equal(starFor('in', 'none'), null);
  });
  test('out: late gold, on_time green, early red, none null', () => {
    assert.equal(starFor('out', 'late'), 'gold');
    assert.equal(starFor('out', 'on_time'), 'green');
    assert.equal(starFor('out', 'early'), 'red');
    assert.equal(starFor('out', 'none'), null);
  });
});

// ---------------------------------------------------------------------
// A September: Mon–Fri 08:00–17:00, Sat 08:00–13:00, Sun off. 1 Sep 2026 is
// a Tuesday. Today is Wed 23 Sep.
// ---------------------------------------------------------------------
const TODAY = '2026-09-23';
const monthDays = (month, { leave = [] } = {}) => {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const wd = new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay();
    const off = wd === 0;
    return {
      date,
      expectedStart: off ? null : '08:00',
      expectedEnd: off ? null : (wd === 6 ? '13:00' : '17:00'),
      onLeave: leave.includes(date),
    };
  });
};
const session = (date, inHHMM, outHHMM, extra = {}) => ({
  clinicDate: date,
  checkInAt: at(date, inHHMM),
  checkOutAt: outHHMM ? at(date, outHHMM) : null,
  status: outHHMM ? 'closed' : 'open',
  checkInPunctuality: 'on_time', lateMinutes: 0,
  checkOutPunctuality: outHHMM ? 'on_time' : 'none', earlyOutMinutes: null,
  ...extra,
});

describe('dayCell()', () => {
  const day = { date: '2026-09-22', expectedStart: '08:00', expectedEnd: '17:00', onLeave: false };
  test('a closed on-time day → two green stars', () => {
    const c = dayCell(day, [session('2026-09-22', '07:58', '17:03')], TODAY);
    assert.equal(c.in, 'green'); assert.equal(c.out, 'green'); assert.equal(c.absent, false);
  });
  test('today, still in → out star pending', () => {
    const c = dayCell({ ...day, date: TODAY }, [session(TODAY, '08:04', null)], TODAY);
    assert.equal(c.in, 'green'); assert.equal(c.out, 'pending');
  });
  test('missed check-out → out star pending', () => {
    const c = dayCell(day, [session('2026-09-22', '08:30', null, { status: 'missed_checkout' })], TODAY);
    assert.equal(c.out, 'pending');
  });
  test('first session gives the in-star, last session the out-star', () => {
    const c = dayCell(day, [
      session('2026-09-22', '07:45', '12:30', { checkInPunctuality: 'early', checkOutPunctuality: 'early' }),
      session('2026-09-22', '13:30', '17:10', { checkInPunctuality: 'none', checkOutPunctuality: 'late' }),
    ], TODAY);
    assert.equal(c.in, 'gold'); assert.equal(c.out, 'gold');
  });
  test('a past working day with nothing recorded is absent, not off', () => {
    const c = dayCell(day, [], TODAY);
    assert.equal(c.absent, true); assert.equal(c.off, false); assert.equal(c.in, null);
  });
  test('leave, off and future days carry no stars', () => {
    assert.equal(dayCell({ ...day, onLeave: true }, [], TODAY).leave, true);
    assert.equal(dayCell({ ...day, date: '2026-09-20', expectedStart: null, expectedEnd: null }, [], TODAY).off, true);
    assert.equal(dayCell({ ...day, date: '2026-09-25' }, [], TODAY).future, true);
  });
});

describe('streakNoRed()', () => {
  const days = monthDays('2026-09');
  test('counts working days back from today, skipping Sundays and today-with-no-tap', () => {
    const rows = [];
    for (const d of ['2026-09-21', '2026-09-22', '2026-09-19', '2026-09-18']) rows.push(session(d, '08:00', '17:00'));
    // Wed 23 (today, no tap) → skip; Tue 22, Mon 21 → 2; Sun 20 off → skip; Sat 19, Fri 18 → 4; Thu 17 absent → break
    assert.equal(streakNoRed({ days, rows, today: TODAY }), 4);
  });
  test('a red star breaks it', () => {
    const rows = [
      session('2026-09-22', '08:00', '17:00'),
      session('2026-09-21', '09:01', '17:00', { checkInPunctuality: 'late', lateMinutes: 61 }),
      session('2026-09-19', '08:00', '13:00'),
    ];
    assert.equal(streakNoRed({ days, rows, today: TODAY }), 1);
  });
  test('leave days neither break nor extend', () => {
    const leaveDays = monthDays('2026-09', { leave: ['2026-09-21'] });
    const rows = [session('2026-09-22', '08:00', '17:00'), session('2026-09-19', '08:00', '13:00')];
    assert.equal(streakNoRed({ days: leaveDays, rows, today: TODAY }), 2);
  });
  test('today with an on-time check-in counts', () => {
    const rows = [session(TODAY, '07:58', null), session('2026-09-22', '08:00', '17:00')];
    assert.equal(streakNoRed({ days, rows, today: TODAY }), 2);
  });
});

describe('monthSummary()', () => {
  const days = monthDays('2026-09', { leave: ['2026-09-10'] });
  const rows = [
    session('2026-09-21', '08:11', '16:52', { checkInPunctuality: 'late', lateMinutes: 11, checkOutPunctuality: 'early', earlyOutMinutes: 8 }),
    session('2026-09-22', '07:58', '17:03', { checkInPunctuality: 'early', checkOutPunctuality: 'late' }),
    session(TODAY, '08:04', null),
    session('2026-09-19', '08:30', null, { status: 'missed_checkout' }),
    session('2026-09-18', '08:00', '17:00', { status: 'voided' }),   // must be ignored
    { ...session('2026-09-17', '08:00', null), status: 'refused' },  // must be ignored
  ];
  const s = monthSummary({ month: '2026-09', days, rows, today: TODAY });

  test('the calendar has one cell per day of the month', () => {
    assert.equal(s.calendar.length, 30);
    assert.equal(s.calendar[9].leave, true);                 // 10 Sep
    assert.equal(s.calendar[5].off, true);                   // Sun 6 Sep
    assert.equal(s.calendar[29].future, true);               // 30 Sep
    assert.equal(s.calendar[16].absent, true);               // 17 Sep (refused only)
  });

  test('stars are counted by side and in total', () => {
    // in: 19 Sep on time (missed check-out still earned its in-star), 21 late, 22 early, 23 on time
    assert.deepEqual(s.stars.in,  { green: 2, gold: 1, red: 1, pending: 0 });
    // out: 19 pending (missed), 21 early, 22 past hours, 23 pending (still in)
    assert.deepEqual(s.stars.out, { green: 0, gold: 1, red: 1, pending: 2 });
    assert.deepEqual(s.stars.all, { green: 2, gold: 2, red: 2, pending: 2 });
  });

  test('the table: hours count only closed sessions; expected covers working days so far', () => {
    assert.equal(s.table.hoursWorkedMinutes, (8 * 60 + 41) + (9 * 60 + 5));
    // 1–23 Sep 2026 (1 Sep = Tue): 17 weekdays × 9 h + 3 Saturdays × 5 h, minus the leave day (Thu 10) 9 h
    assert.equal(s.table.expectedMinutes, (17 * 9 + 3 * 5 - 9) * 60);
    assert.deepEqual(s.table.workingDays, { worked: 4, total: 25, soFar: 19, leave: 1 });
    assert.equal(s.table.lateMinutesTotal, 11);
    assert.equal(s.table.lateCount, 1);
    assert.deepEqual(s.table.lateDates, ['2026-09-21']);
    assert.equal(s.table.earlyOutMinutesTotal, 8);
    assert.equal(s.table.earlyOutCount, 1);
    assert.equal(s.table.missedCheckouts, 1);
    assert.equal(s.table.avgIn, '08:11');    // 08:30, 08:11, 07:58, 08:04 → 08:10.75 → rounds to 08:11
    assert.equal(s.table.avgOut, '16:58');   // 16:52, 17:03 → 16:57.5 → rounds to 16:58
  });
});

describe('time helpers', () => {
  test('minutesBetween ignores seconds', () => {
    assert.equal(minutesBetween(new Date('2026-09-23T08:00:59+03:00'), new Date('2026-09-23T08:01:00+03:00')), 1);
    assert.equal(minutesBetween(new Date('2026-09-23T08:00:00+03:00'), new Date('2026-09-23T08:00:59+03:00')), 0);
  });
  test('clinicHHMM renders the clinic wall clock', () => {
    assert.equal(clinicHHMM(new Date('2026-09-23T05:04:00Z')), '08:04');
  });
});
