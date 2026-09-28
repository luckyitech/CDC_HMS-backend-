const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { entitlementFor, carriedIn, summarise, checkBalance, monthsEmployedIn } = require('../utils/leaveBalance');

// B27 — balances are computed on read (spec §5).

const ANNUAL = { days: 21, grant: 'up_front', carryCap: 5, enabled: true };
const TYPES = [{ key: 'Annual', name: 'Annual' }, { key: 'Sick', name: 'Sick' }];

describe('entitlement', () => {
  test('the policy days, up front', () => {
    assert.deepEqual(entitlementFor({ policyType: ANNUAL, year: 2026, asOf: '2026-03-01' }),
      { unlimited: false, entitled: 21, available: 21, source: 'policy', proRated: false });
  });
  test('a per-person override wins, and is never pro-rated', () => {
    const e = entitlementFor({ policyType: ANNUAL, override: { entitled: '25.00' }, year: 2026, proRate: true, employment: { startDate: '2026-07-01' } });
    assert.equal(e.entitled, 25); assert.equal(e.source, 'override');
  });
  test('an override row with no entitlement set falls back to the policy', () => {
    assert.equal(entitlementFor({ policyType: ANNUAL, override: { entitled: null, carriedOver: 2 }, year: 2026 }).entitled, 21);
  });
  test('pro-rata for a joiner on 1 July: about half, to the quarter day', () => {
    const e = entitlementFor({ policyType: ANNUAL, year: 2026, proRate: true, employment: { startDate: '2026-07-01' } });
    assert.equal(e.proRated, true);
    assert.equal(e.entitled, 10.5);
  });
  test('per-event types (maternity) are never pro-rated', () => {
    const e = entitlementFor({ policyType: { days: 90, grant: 'per_event', enabled: true }, year: 2026, proRate: true, employment: { startDate: '2026-07-01' } });
    assert.equal(e.entitled, 90); assert.equal(e.proRated, false);
  });
    test('pro-rata off: a joiner gets the full year', () => {
    assert.equal(entitlementFor({ policyType: ANNUAL, year: 2026, employment: { startDate: '2026-07-01' } }).entitled, 21);
  });
  test('monthly accrual: available grows month by month', () => {
    const monthly = { ...ANNUAL, days: 24, grant: 'monthly' };
    assert.equal(entitlementFor({ policyType: monthly, year: 2026, asOf: '2026-01-15' }).available, 0);
    assert.equal(entitlementFor({ policyType: monthly, year: 2026, asOf: '2026-01-31' }).available, 2);
    assert.equal(entitlementFor({ policyType: monthly, year: 2026, asOf: '2026-03-15' }).available, 4);
    assert.equal(entitlementFor({ policyType: monthly, year: 2026, asOf: '2026-12-31' }).available, 24);
  });
  test('unlimited types have no number', () => {
    const e = entitlementFor({ policyType: { days: null, grant: 'unlimited' }, year: 2026 });
    assert.equal(e.unlimited, true); assert.equal(e.entitled, null);
  });
  test('a type disabled this year gives nothing', () => {
    assert.equal(entitlementFor({ policyType: { ...ANNUAL, enabled: false }, year: 2026 }).entitled, 0);
  });
  test('months employed is a year-share', () => {
    assert.equal(Math.round(monthsEmployedIn(2026, {})), 12);
    assert.equal(Math.round(monthsEmployedIn(2026, { endDate: '2026-06-30' })), 6);
  });
});

describe('carry-over', () => {
  test('capped, never negative, HR override wins', () => {
    assert.equal(carriedIn({ prevRemaining: 9, carryCap: 5 }), 5);
    assert.equal(carriedIn({ prevRemaining: 3, carryCap: 5 }), 3);
    assert.equal(carriedIn({ prevRemaining: -2, carryCap: 5 }), 0);
    assert.equal(carriedIn({ prevRemaining: 9, carryCap: 5, overrideCarried: 7 }), 7);
    assert.equal(carriedIn({ prevRemaining: 9, carryCap: 0 }), 0);
  });
});

describe('the balance picture', () => {
  const base = {
    year: 2026, types: TYPES,
    policyTypes: { Annual: ANNUAL, Sick: { days: 14, grant: 'up_front', enabled: true } },
    policy: { carryExpiry: '03-31' },
    carried: { Annual: 5 },
  };

  test('taken and booked come from charges, remaining from both', () => {
    const [annual] = summarise({
      ...base, asOf: '2026-02-01',
      charges: [
        { leaveType: 'Annual', days: '3.00', startDate: '2026-01-12', state: 'taken' },
        { leaveType: 'Annual', days: 2, startDate: '2026-05-04', state: 'booked' },
      ],
    });
    assert.equal(annual.taken, 3);
    assert.equal(annual.booked, 2);
    assert.equal(annual.remaining, 23);              // 21 + 5 carried − 3
    assert.equal(annual.remainingAfterBooked, 21);
  });

  test('carried days are used first (FIFO) by leave starting before expiry, the rest lapse after it', () => {
    const charges = [{ leaveType: 'Annual', days: 3, startDate: '2026-02-09', state: 'taken' }];
    const before = summarise({ ...base, asOf: '2026-03-01', charges })[0];
    assert.equal(before.carriedUsed, 3);
    assert.equal(before.carriedLeft, 2);
    assert.equal(before.carriedLapsed, 0);
    assert.equal(before.carryExpires, '2026-03-31');
    assert.equal(before.remaining, 23);

    const after = summarise({ ...base, asOf: '2026-04-01', charges })[0];
    assert.equal(after.carriedLapsed, 2);
    assert.equal(after.carriedLeft, 0);
    assert.equal(after.carryExpires, null);
    assert.equal(after.remaining, 21);               // 21 + 5 − 2 lapsed − 3
  });

  test('leave after the expiry does not use carried days', () => {
    const charges = [{ leaveType: 'Annual', days: 4, startDate: '2026-06-01', state: 'taken' }];
    const s = summarise({ ...base, asOf: '2026-07-01', charges })[0];
    assert.equal(s.carriedUsed, 0);
    assert.equal(s.carriedLapsed, 5);
    assert.equal(s.remaining, 17);
  });

  test('a split charge lands on each balance (2 sick + 3 annual)', () => {
    const charges = [
      { leaveType: 'Sick', days: 2, startDate: '2026-05-04', state: 'taken' },
      { leaveType: 'Annual', days: 3, startDate: '2026-05-04', state: 'taken' },
    ];
    const [annual, sick] = summarise({ ...base, asOf: '2026-06-01', charges, carried: {} });
    assert.equal(annual.taken, 3); assert.equal(annual.remaining, 18);
    assert.equal(sick.taken, 2); assert.equal(sick.remaining, 12);
  });

  test('HR chooses which types staff can see', () => {
    const s = summarise({ ...base, asOf: '2026-06-01', policy: { ...base.policy, visibleTypes: ['Annual'] } });
    assert.deepEqual(s.map((x) => [x.leaveType, x.visible]), [['Annual', true], ['Sick', false]]);
  });

  test('an override of carried-over days replaces the computed carry', () => {
    const s = summarise({ ...base, asOf: '2026-02-01', overrides: { Annual: { carriedOver: '1.5' } } })[0];
    assert.equal(s.carriedIn, 1.5);
  });
});

describe('is there enough left?', () => {
  const summary = [{ leaveType: 'Annual', unlimited: false, remainingAfterBooked: 4 },
    { leaveType: 'Compassionate', unlimited: true, remainingAfterBooked: null }];

  test('refuses beyond the balance, with the shortfall', () => {
    assert.deepEqual(checkBalance({ summary, charges: [{ leaveType: 'Annual', days: 5 }] }), { ok: false, short: { Annual: 1 } });
  });
  test('allows up to the balance', () => {
    assert.equal(checkBalance({ summary, charges: [{ leaveType: 'Annual', days: 4 }] }).ok, true);
  });
  test('unlimited types are never short', () => {
    assert.equal(checkBalance({ summary, charges: [{ leaveType: 'Compassionate', days: 40 }] }).ok, true);
  });
  test('a policy allowing a negative balance lets it through', () => {
    assert.equal(checkBalance({ summary, charges: [{ leaveType: 'Annual', days: 9 }], allowNegative: true }).ok, true);
  });
});
