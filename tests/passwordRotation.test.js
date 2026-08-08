const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  currentPeriodStart, nextRotationDate, isPasswordExpired,
  ROTATING_ROLES, INTERVALS, isValidInterval,
} = require('../utils/passwordRotation');

// =====================================================================
// Scheduled staff password rotation — the date arithmetic only.
//
// Pure functions, no database: isPasswordExpired answers "is this password
// older than the current period?" and knows nothing about whether the feature
// is switched on. The cases that matter are the period boundaries themselves
// (Sunday night vs Monday morning), the start of a month that does not begin
// on a Monday, and the roles that are exempt.
// =====================================================================

// 2026-08-03 is a Monday, and also the first Monday of August 2026.
// Times are clinic-local (+03).
const at = (iso) => new Date(`${iso}T09:00:00+03:00`);
const MONDAY    = at('2026-08-03');
const WEDNESDAY = at('2026-08-05');
const SUNDAY    = new Date('2026-08-09T22:00:00+03:00');

const staffWith = (passwordChangedAt, role = 'doctor') => ({ role, passwordChangedAt });

const isMonday = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
};

describe('interval definitions', () => {
  test('exactly the three the admin can pick', () => {
    assert.deepEqual(Object.keys(INTERVALS), ['weekly', 'fortnightly', 'monthly']);
  });

  test('unknown intervals are rejected', () => {
    assert.equal(isValidInterval('weekly'), true);
    assert.equal(isValidInterval('daily'), false);
    assert.equal(isValidInterval(undefined), false);
  });
});

describe('currentPeriodStart — weekly', () => {
  test('is today when today is Monday', () => {
    assert.equal(currentPeriodStart('weekly', MONDAY), '2026-08-03');
  });

  test('is the Monday just gone on a midweek day', () => {
    assert.equal(currentPeriodStart('weekly', WEDNESDAY), '2026-08-03');
  });

  test('Sunday still belongs to the period that opened on Monday', () => {
    // The bug this guards: treating Sunday as the start of a new period would
    // expire everyone a day early, every single time.
    assert.equal(currentPeriodStart('weekly', SUNDAY), '2026-08-03');
  });
});

describe('currentPeriodStart — fortnightly', () => {
  test('holds the same start across both weeks of the period', () => {
    assert.equal(currentPeriodStart('fortnightly', at('2026-08-03')), '2026-08-03');
    assert.equal(currentPeriodStart('fortnightly', at('2026-08-09')), '2026-08-03');
    assert.equal(currentPeriodStart('fortnightly', at('2026-08-10')), '2026-08-03', 'week two, same period');
    assert.equal(currentPeriodStart('fortnightly', at('2026-08-16')), '2026-08-03');
  });

  test('rolls over on the second Monday', () => {
    assert.equal(currentPeriodStart('fortnightly', at('2026-08-17')), '2026-08-17');
  });

  test('the schedule is anchored to a fixed epoch, not to when it was switched on', () => {
    // Toggling the feature off and on must not shift which Mondays count, or
    // the clinic's rotation date would wander every time someone touches it.
    const starts = ['2026-08-03', '2026-08-17', '2026-08-31', '2026-09-14'];
    for (const s of starts) assert.equal(currentPeriodStart('fortnightly', at(s)), s);
  });
});

describe('currentPeriodStart — monthly', () => {
  test('is the first Monday of the month', () => {
    assert.equal(currentPeriodStart('monthly', at('2026-08-03')), '2026-08-03');
    assert.equal(currentPeriodStart('monthly', at('2026-08-31')), '2026-08-03');
    assert.equal(currentPeriodStart('monthly', at('2026-09-07')), '2026-09-07');
  });

  test('days before the first Monday still belong to last month period', () => {
    // 1 Aug 2026 is a Saturday; the first Monday is the 3rd. Without this the
    // period would silently restart on the 1st and expire everyone early.
    assert.equal(currentPeriodStart('monthly', at('2026-08-01')), '2026-07-06');
    assert.equal(currentPeriodStart('monthly', at('2026-08-02')), '2026-07-06');
  });

  test('handles a month that begins on a Monday', () => {
    // 1 June 2026 is a Monday — the period starts on the 1st itself.
    assert.equal(currentPeriodStart('monthly', at('2026-06-01')), '2026-06-01');
    assert.equal(currentPeriodStart('monthly', at('2026-06-30')), '2026-06-01');
  });

  test('crosses a year boundary', () => {
    // 1 Jan 2027 is a Friday, so early January still belongs to December.
    assert.equal(currentPeriodStart('monthly', at('2027-01-02')), '2026-12-07');
    assert.equal(currentPeriodStart('monthly', at('2027-01-04')), '2027-01-04');
  });
});

describe('nextRotationDate', () => {
  test('weekly is a week on', () => {
    assert.equal(nextRotationDate('weekly', WEDNESDAY), '2026-08-10');
  });

  test('fortnightly is a fortnight on', () => {
    assert.equal(nextRotationDate('fortnightly', WEDNESDAY), '2026-08-17');
  });

  test('monthly is the first Monday of next month', () => {
    assert.equal(nextRotationDate('monthly', WEDNESDAY), '2026-09-07');
  });

  test('monthly crosses December into January', () => {
    assert.equal(nextRotationDate('monthly', at('2026-12-14')), '2027-01-04');
  });

  test('on a rotation Monday it points at the next one, not today', () => {
    // Today's rotation has already happened — a password set this morning is
    // good for the period, so the date shown to the user must be the next one.
    assert.equal(nextRotationDate('weekly', MONDAY), '2026-08-10');
    assert.equal(nextRotationDate('fortnightly', MONDAY), '2026-08-17');
    assert.equal(nextRotationDate('monthly', MONDAY), '2026-09-07');
  });

  test('always lands on a Monday, and always in the future', () => {
    for (const interval of Object.keys(INTERVALS)) {
      for (let d = 1; d <= 60; d += 1) {
        const day = new Date(Date.UTC(2026, 7, d, 6)).toISOString().slice(0, 10);
        const next = nextRotationDate(interval, at(day));
        assert.ok(isMonday(next), `${interval} ${day} → ${next} should be a Monday`);
        assert.ok(next > currentPeriodStart(interval, at(day)), `${interval} ${day}: next must be ahead`);
      }
    }
  });
});

describe('isPasswordExpired', () => {
  test('a password never set by the user is expired', () => {
    // An admin-created account still on its emailed temp password.
    assert.equal(isPasswordExpired(staffWith(null), 'weekly', WEDNESDAY), true);
  });

  test('set before the period opened — expired', () => {
    assert.equal(isPasswordExpired(staffWith(at('2026-07-31')), 'weekly', WEDNESDAY), true);
  });

  test('set at 23:59 Sunday — expired on Monday morning', () => {
    const sundayNight = new Date('2026-08-02T23:59:00+03:00');
    assert.equal(isPasswordExpired(staffWith(sundayNight), 'weekly', MONDAY), true);
  });

  test('set at 00:01 Monday — still valid', () => {
    const mondayEarly = new Date('2026-08-03T00:01:00+03:00');
    assert.equal(isPasswordExpired(staffWith(mondayEarly), 'weekly', WEDNESDAY), false);
  });

  test('a longer interval keeps the same password valid for longer', () => {
    // Set Monday 3 Aug; checked Tuesday 11 Aug, which is a new week but the
    // same fortnight and the same month.
    const setOn = at('2026-08-03');
    const checked = at('2026-08-11');
    assert.equal(isPasswordExpired(staffWith(setOn), 'weekly', checked), true);
    assert.equal(isPasswordExpired(staffWith(setOn), 'fortnightly', checked), false);
    assert.equal(isPasswordExpired(staffWith(setOn), 'monthly', checked), false);
  });

  test('set on Saturday — expires the following Monday, two days later', () => {
    // Intended: the rotation day is fixed, so a late-period change does not buy
    // a full period. Documented behaviour, not an accident.
    const saturday = at('2026-08-08');
    assert.equal(isPasswordExpired(staffWith(saturday), 'weekly', SUNDAY), false, 'still fine on Sunday');
    assert.equal(isPasswordExpired(staffWith(saturday), 'weekly', at('2026-08-10')), true, 'expired Monday');
  });

  test('applies to every rotating role, on every interval', () => {
    for (const role of ROTATING_ROLES) {
      for (const interval of Object.keys(INTERVALS)) {
        assert.equal(isPasswordExpired(staffWith(null, role), interval, WEDNESDAY), true, `${role}/${interval}`);
      }
    }
  });

  test('admins and patients are exempt even with no password change on record', () => {
    // The admin holds the on/off switch; locking them out leaves no way back.
    for (const interval of Object.keys(INTERVALS)) {
      assert.equal(isPasswordExpired(staffWith(null, 'admin'), interval, WEDNESDAY), false);
      assert.equal(isPasswordExpired(staffWith(null, 'patient'), interval, WEDNESDAY), false);
    }
  });
});
