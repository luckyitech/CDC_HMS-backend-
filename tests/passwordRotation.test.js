const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../models');
const {
  expiryCutoff, passwordExpiresAt, shiftByInterval, isPasswordExpired,
  getRotationConfig, clearRotationCache,
  ROTATING_ROLES, INTERVALS, DEFAULT_INTERVAL, MINIMUM_PASSWORD_AGE_DAYS, isValidInterval,
} = require('../utils/passwordRotation');

// =====================================================================
// Scheduled staff password rotation — the interval arithmetic only.
//
// Pure functions, no database: isPasswordExpired answers "is this password
// older than one whole interval?" and knows nothing about whether the feature
// is switched on. The clock runs per user from when THEY last set a password,
// so the cases that matter are the boundary itself (one interval to the
// second), month-length clamping, the never-set case, and the exempt roles.
// =====================================================================

const DAY = 86_400_000;
const at = (iso) => new Date(`${iso}T09:00:00+03:00`);   // clinic-local (+03)
const daysBefore = (now, n) => new Date(now.getTime() - n * DAY);

const NOW = at('2026-08-10');
const staffWith = (passwordChangedAt, role = 'doctor') => ({ role, passwordChangedAt });
const iso = (d) => d.toISOString().slice(0, 10);

describe('interval definitions', () => {
  test('exactly the three the admin can pick', () => {
    assert.deepEqual(Object.keys(INTERVALS), ['weekly', 'fortnightly', 'monthly']);
  });

  test('unknown intervals are rejected', () => {
    assert.equal(isValidInterval('weekly'), true);
    assert.equal(isValidInterval('daily'), false);
    assert.equal(isValidInterval(undefined), false);
  });

  test('labels read as "set a new password <label>"', () => {
    assert.equal(INTERVALS.weekly.label, 'every week');
    assert.equal(INTERVALS.fortnightly.label, 'every two weeks');
    assert.equal(INTERVALS.monthly.label, 'every month');
  });
});

describe('interval arithmetic', () => {
  test('weekly and fortnightly are plain day counts', () => {
    assert.equal(iso(shiftByInterval(at('2026-08-10'), 'weekly', 1)), '2026-08-17');
    assert.equal(iso(shiftByInterval(at('2026-08-10'), 'fortnightly', 1)), '2026-08-24');
  });

  test('monthly is a calendar month, not 30 days', () => {
    assert.equal(iso(shiftByInterval(at('2026-08-10'), 'monthly', 1)), '2026-09-10');
    assert.equal(iso(shiftByInterval(at('2026-02-10'), 'monthly', 1)), '2026-03-10');
  });

  test('month arithmetic clamps instead of overflowing', () => {
    // The bug this guards: setMonth() alone turns 31 Jan + 1 month into 3 March,
    // quietly handing a January user three extra days of password life.
    assert.equal(iso(shiftByInterval(at('2026-01-31'), 'monthly', 1)), '2026-02-28');
    assert.equal(iso(shiftByInterval(at('2026-03-31'), 'monthly', 1)), '2026-04-30');
    assert.equal(iso(shiftByInterval(at('2028-01-31'), 'monthly', 1)), '2028-02-29', 'leap year');
  });

  test('crosses a year boundary', () => {
    assert.equal(iso(shiftByInterval(at('2026-12-20'), 'monthly', 1)), '2027-01-20');
    assert.equal(iso(shiftByInterval(at('2026-12-29'), 'weekly', 1)), '2027-01-05');
  });

  test('the cutoff is exactly one interval behind now', () => {
    assert.equal(iso(expiryCutoff('weekly', NOW)), '2026-08-03');
    assert.equal(iso(expiryCutoff('fortnightly', NOW)), '2026-07-27');
    assert.equal(iso(expiryCutoff('monthly', NOW)), '2026-07-10');
  });
});

describe('passwordExpiresAt — the per-user clock', () => {
  test('runs from when the user set it, not from a shared calendar date', () => {
    // This is the whole point of the rolling model: two people who changed on
    // different days get different expiry dates.
    assert.equal(iso(passwordExpiresAt(staffWith(at('2026-08-08')), 'weekly')), '2026-08-15');
    assert.equal(iso(passwordExpiresAt(staffWith(at('2026-08-10')), 'weekly')), '2026-08-17');
    assert.equal(iso(passwordExpiresAt(staffWith(at('2026-08-12')), 'weekly')), '2026-08-19');
  });

  test('a Saturday change buys a full period, not two days', () => {
    // The behaviour that was asked for. Under the old fixed-Monday schedule a
    // password set on Saturday 8 Aug expired on Monday 10 Aug.
    const saturday = at('2026-08-08');
    assert.equal(iso(passwordExpiresAt(staffWith(saturday), 'weekly')), '2026-08-15');
    assert.equal(isPasswordExpired(staffWith(saturday), 'weekly', at('2026-08-10')), false);
  });

  test('null when the user has never set their own password', () => {
    assert.equal(passwordExpiresAt(staffWith(null), 'weekly'), null);
  });
});

describe('isPasswordExpired', () => {
  test('a password never set by the user is due immediately', () => {
    // An admin-created account still on its emailed temp password, or one reset
    // by scripts/set-password.js. The admin knows it, so the user does not own it.
    for (const interval of Object.keys(INTERVALS)) {
      assert.equal(isPasswordExpired(staffWith(null), interval, NOW), true, interval);
    }
  });

  test('valid right up to the boundary, expired on it', () => {
    assert.equal(isPasswordExpired(staffWith(daysBefore(NOW, 6)), 'weekly', NOW), false, 'day 6');
    assert.equal(isPasswordExpired(staffWith(daysBefore(NOW, 7)), 'weekly', NOW), true, 'day 7');
    assert.equal(isPasswordExpired(staffWith(daysBefore(NOW, 8)), 'weekly', NOW), true, 'day 8');
  });

  test('a longer interval keeps the same password valid for longer', () => {
    const tenDaysOld = staffWith(daysBefore(NOW, 10));
    assert.equal(isPasswordExpired(tenDaysOld, 'weekly', NOW), true);
    assert.equal(isPasswordExpired(tenDaysOld, 'fortnightly', NOW), false);
    assert.equal(isPasswordExpired(tenDaysOld, 'monthly', NOW), false);
  });

  test('every rotating role is treated the same', () => {
    for (const role of ROTATING_ROLES) {
      assert.equal(isPasswordExpired(staffWith(null, role), 'weekly', NOW), true, role);
      assert.equal(isPasswordExpired(staffWith(daysBefore(NOW, 1), role), 'weekly', NOW), false, role);
    }
  });

  test('admins and patients are exempt even with no password change on record', () => {
    // The admin holds the on/off switch; locking them out leaves no way back.
    for (const interval of Object.keys(INTERVALS)) {
      assert.equal(isPasswordExpired(staffWith(null, 'admin'), interval, NOW), false);
      assert.equal(isPasswordExpired(staffWith(null, 'patient'), interval, NOW), false);
    }
  });
});

describe('grace floor', () => {
  // Today every interval is longer than the floor, so the interval test is what
  // actually decides and the floor is a backstop. It exists so that shortening
  // an interval — or adding a shorter one later — cannot expire somebody the
  // same morning they chose a new password. These lock in the invariant.
  test('a freshly chosen password is never expired, on any interval', () => {
    for (const interval of Object.keys(INTERVALS)) {
      assert.equal(isPasswordExpired(staffWith(NOW), interval, NOW), false, `${interval} @ 0 days`);
    }
  });

  test('no self-chosen password expires before the floor, on any interval', () => {
    for (const interval of Object.keys(INTERVALS)) {
      for (let hours = 0; hours < MINIMUM_PASSWORD_AGE_DAYS * 24; hours += 1) {
        const changedAt = new Date(NOW.getTime() - hours * 3_600_000);
        assert.equal(
          isPasswordExpired(staffWith(changedAt), interval, NOW), false,
          `${interval} @ ${hours}h`
        );
      }
    }
  });

  test('the floor does not rescue a password the user never chose', () => {
    // Rule 1 beats rule 2: a temp password is due however recently it was issued.
    assert.equal(isPasswordExpired(staffWith(null), DEFAULT_INTERVAL, NOW), true);
  });
});

describe('invariants over a long run', () => {
  test('changing your password now never leaves you expired', () => {
    for (const interval of Object.keys(INTERVALS)) {
      for (let d = 0; d < 400; d += 1) {
        const now = new Date(Date.UTC(2026, 0, 1 + d, 9));
        assert.equal(
          isPasswordExpired(staffWith(now), interval, now), false,
          `${interval} ${iso(now)}`
        );
      }
    }
  });

  test('expiry is always in the future of the change, and ordered by interval', () => {
    for (let d = 0; d < 400; d += 1) {
      const changedAt = new Date(Date.UTC(2026, 0, 1 + d, 9));
      const user = staffWith(changedAt);
      const weekly = passwordExpiresAt(user, 'weekly');
      const fortnightly = passwordExpiresAt(user, 'fortnightly');
      const monthly = passwordExpiresAt(user, 'monthly');
      assert.ok(weekly > changedAt, `weekly ${iso(changedAt)}`);
      assert.ok(fortnightly > weekly, `fortnightly ${iso(changedAt)}`);
      assert.ok(monthly > fortnightly, `monthly ${iso(changedAt)}`);
    }
  });
});

describe('ships switched off', () => {
  // The whole feature is inert until an administrator turns it on. This matters
  // most at deploy time: pushing this code to a live clinic must change nothing
  // for anyone until somebody makes that decision deliberately.
  //
  // Setting.findAll is stubbed rather than mocked wholesale — no database is
  // needed, and the assertion is about how the rows are READ, which is the part
  // that could regress.
  const withRows = async (rows) => {
    db.Setting.findAll = typeof rows === 'function' ? rows : async () => rows;
    clearRotationCache();
    return getRotationConfig();
  };

  test('a fresh server with no Setting row is off', async () => {
    assert.equal((await withRows([])).enabled, false);
  });

  test('an unreadable settings table fails safe, not open', async () => {
    // Locking every clinical user out because a lookup blipped would be a far
    // worse outcome than a password living a few minutes past its expiry.
    const cfg = await withRows(async () => { throw new Error('db unreachable'); });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.interval, DEFAULT_INTERVAL);
  });

  test('only the exact string "true" enables it', async () => {
    for (const value of ['false', 'TRUE', '1', 'yes', '', 'on']) {
      assert.equal((await withRows([{ key: 'passwordRotationEnabled', value }])).enabled, false, value);
    }
    assert.equal((await withRows([{ key: 'passwordRotationEnabled', value: 'true' }])).enabled, true);
  });

  test('a nonsense interval falls back rather than throwing', async () => {
    const cfg = await withRows([
      { key: 'passwordRotationEnabled', value: 'true' },
      { key: 'passwordRotationInterval', value: 'hourly' },
    ]);
    assert.equal(cfg.interval, DEFAULT_INTERVAL);
  });
});
