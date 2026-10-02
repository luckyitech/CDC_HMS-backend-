const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../utils/leavePolicyRules');
const { summarise } = require('../utils/leaveBalance');

// =====================================================================
// B27 phase 1b (28 Sep 2026, Emu's rulings on the Phase 1 open decisions):
//   - pro-rata is chosen PER TYPE (Annual on, Sick off) — migration
//     20260928000007 adds LeavePolicyTypes.proRate;
//   - per-type notice is editable on the Leave settings screen (already
//     stored since phase 0 — validated here).
// Kept: holidays in attendance from deploy; publishing is one-way.
// No database.
// =====================================================================

const ACTIVE = ['Annual', 'Sick', 'Maternity', 'Paternity', 'Compassionate', 'Study', 'Unpaid'];
const WEEK = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
const body = (types, extra = {}) => ({
  weekWeights: { ...WEEK }, countingMode: 'clinic_week', carryExpiry: null, minNoticeDays: 7, types, ...extra,
});

describe('validatePolicy — pro-rata per type', () => {
  test('Annual on, Sick off are kept as sent; the policy switch is derived', () => {
    const r = rules.validatePolicy(body({
      Annual: { days: 21, grant: 'up_front', proRate: true, enabled: true },
      Sick:   { days: 14, grant: 'up_front', proRate: false, enabled: true },
    }), { activeKeys: ACTIVE });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.value.types.Annual.proRate, true);
    assert.equal(r.value.types.Sick.proRate, false);
    assert.equal(r.value.proRate, true, 'at least one type is pro-rated');
  });
  test('per-event and no-limit types are never pro-rated, whatever is sent', () => {
    const r = rules.validatePolicy(body({
      Maternity: { days: 90, countedAs: 'calendar', grant: 'per_event', proRate: true, enabled: true },
      Study:     { grant: 'unlimited', proRate: true, enabled: true },
    }), { activeKeys: ACTIVE });
    assert.equal(r.value.types.Maternity.proRate, false);
    assert.equal(r.value.types.Study.proRate, false);
    assert.equal(r.value.proRate, false, 'no yearly type pro-rated → the switch is off');
  });
  test('monthly accrual may be pro-rated', () => {
    const r = rules.validatePolicy(body({ Annual: { days: 21, grant: 'monthly', proRate: true, enabled: true } }), { activeKeys: ACTIVE });
    assert.equal(r.value.types.Annual.proRate, true);
  });
  test('a switched-off type does not turn the derived switch on', () => {
    const r = rules.validatePolicy(body({ Annual: { days: 21, grant: 'up_front', proRate: true, enabled: false } }), { activeKeys: ACTIVE });
    assert.equal(r.value.proRate, false);
  });
  test('a row that does not say (an older copy) falls back to the body switch, and defaults to off', () => {
    const withOld = rules.validatePolicy(body({ Annual: { days: 21, grant: 'up_front', enabled: true } }, { proRate: true }), { activeKeys: ACTIVE });
    assert.equal(withOld.value.types.Annual.proRate, true);
    const none = rules.validatePolicy(body({ Annual: { days: 21, grant: 'up_front', enabled: true } }), { activeKeys: ACTIVE });
    assert.equal(none.value.types.Annual.proRate, false);
  });
});

describe('validatePolicy — per-type notice (now on screen)', () => {
  test('blank means the clinic default; whole days 0–365 only', () => {
    const ok = rules.validatePolicy(body({
      Annual: { days: 21, grant: 'up_front', minNoticeDays: 14, enabled: true },
      Sick:   { days: 14, grant: 'up_front', minNoticeDays: '', enabled: true },
    }), { activeKeys: ACTIVE });
    assert.equal(ok.ok, true, ok.errors.join('; '));
    assert.equal(ok.value.types.Annual.minNoticeDays, 14);
    assert.equal(ok.value.types.Sick.minNoticeDays, null);
    for (const bad of [-1, 366, 2.5]) {
      const r = rules.validatePolicy(body({ Annual: { days: 21, grant: 'up_front', minNoticeDays: bad, enabled: true } }), { activeKeys: ACTIVE });
      assert.equal(r.ok, false, String(bad));
      assert.match(r.errors[0], /notice/);
    }
  });
});

describe('balances — a July joiner under the per-type rule', () => {
  const types = [{ key: 'Annual', name: 'Annual' }, { key: 'Sick', name: 'Sick' }, { key: 'Maternity', name: 'Maternity' }];
  const policyTypes = {
    Annual:    { days: 21, grant: 'up_front', enabled: true, proRate: true },
    Sick:      { days: 14, grant: 'up_front', enabled: true, proRate: false },
    Maternity: { days: 90, grant: 'per_event', enabled: true, proRate: true }, // never, even if a row said so
  };
  const rows = summarise({
    year: 2026, asOf: '2026-09-28', types, policy: { carryExpiry: null }, policyTypes,
    employment: { startDate: '2026-07-01' },
  });
  const by = Object.fromEntries(rows.map((r) => [r.leaveType, r]));
  test('Annual is pro-rated', () => {
    assert.equal(by.Annual.proRated, true);
    assert.equal(by.Annual.entitled, 10.5);
  });
  test('Sick is the full 14 days', () => {
    assert.equal(by.Sick.proRated, false);
    assert.equal(by.Sick.entitled, 14);
  });
  test('Maternity stays a full allowance per event', () => {
    assert.equal(by.Maternity.proRated, false);
    assert.equal(by.Maternity.entitled, 90);
  });
  test('the old policy-level switch no longer decides anything', () => {
    const r = summarise({
      year: 2026, asOf: '2026-09-28', types: [{ key: 'Sick', name: 'Sick' }], policy: { proRate: true },
      policyTypes: { Sick: policyTypes.Sick }, employment: { startDate: '2026-07-01' },
    });
    assert.equal(r[0].entitled, 14);
  });
});

describe('migration 20260928000007 — per-type pro-rata', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20260928000007-leave-policy-type-pro-rata.js'), 'utf8');
  const mig = require('../migrations/20260928000007-leave-policy-type-pro-rata');
  test('guarded both ways, table names case-insensitive', () => {
    assert.match(src, /showAllTables/);
    assert.match(src, /toLowerCase\(\) === name\.toLowerCase\(\)/);
    assert.match(src, /if \(cols\.proRate\) return;/);
    assert.match(src, /if \(!cols\.proRate\) return;/);
    assert.equal(typeof mig.up, 'function');
    assert.equal(typeof mig.down, 'function');
  });
  test('the backfill turns Sick off and only touches yearly types; reserved words are backticked', () => {
    assert.match(src, /t\.\\`key\\` <> 'Sick'/);
    assert.match(src, /pt\.\\`grant\\` IN \('up_front', 'monthly'\)/);
  });
  test('down restores the policy switch from its types before dropping the column', () => {
    const down = src.slice(src.indexOf('async down'));
    assert.ok(down.indexOf('SET p.proRate') < down.indexOf('removeColumn'));
  });
  test('the model lists the column (a model column the DB lacks would 500 every query — they ship together)', () => {
    const model = fs.readFileSync(path.join(__dirname, '..', 'models', 'LeavePolicyType.js'), 'utf8');
    assert.match(model, /proRate:\s+\{ type: DataTypes\.BOOLEAN, allowNull: false, defaultValue: false \}/);
  });
});
