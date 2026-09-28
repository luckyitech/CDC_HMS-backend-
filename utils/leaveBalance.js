// Leave balances — what someone is entitled to, what they have used, what is left.
//
// B27 (spec §5). Pure: no database, no clock (the caller passes `asOf`).
// Balances are COMPUTED ON READ from:
//   - the year's policy row for the type (days, grant, carry cap, …),
//   - the person's override row, if HR set one (D1: per-person +/-),
//   - the carried-in days from last year,
//   - the leave CHARGES — which balance each approved day came off (D7).
// There is no year-end job to fail: the numbers always follow from the rows.
//
// Carried days are used FIRST by leave starting on or before the carry-over
// expiry; whatever is still unused at expiry lapses.

const { toUtcDate } = require('./leaveDays');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const quarter = (n) => Math.round(n * 4) / 4;
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);   // DECIMAL columns arrive as strings from mysql2
  return Number.isFinite(n) ? n : null;
};

const yearStart = (year) => toUtcDate(`${year}-01-01`);
const yearEnd = (year) => toUtcDate(`${year}-12-31`);
const daysInYear = (year) => Math.round((yearEnd(year) - yearStart(year)) / MS_PER_DAY) + 1;

/**
 * The share of the year someone is employed, in month-equivalents (0–12).
 * Days employed ÷ days in the year × 12, so joining on 1 July reads as ~6.
 */
const monthsEmployedIn = (year, { startDate, endDate } = {}) => {
  const from = startDate ? new Date(Math.max(toUtcDate(startDate), yearStart(year))) : yearStart(year);
  const to = endDate ? new Date(Math.min(toUtcDate(endDate), yearEnd(year))) : yearEnd(year);
  if (to < from) return 0;
  const days = Math.round((to - from) / MS_PER_DAY) + 1;
  return (days / daysInYear(year)) * 12;
};

const isLastDayOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).getUTCDate() === 1;

/**
 * Entitlement for one type, one person, one year.
 *
 * @returns {{ unlimited: boolean, entitled: number|null, available: number|null,
 *             source: 'policy'|'override'|'none', proRated: boolean }}
 *   `available` is what can be used so far: the whole entitlement up front, or
 *   the accrued share under monthly accrual.
 */
const entitlementFor = ({ policyType, override, employment = {}, year, asOf, proRate = false } = {}) => {
  const overrideDays = num(override?.entitled);
  if (overrideDays !== null) {
    return { unlimited: false, entitled: overrideDays, available: overrideDays, source: 'override', proRated: false };
  }
  if (!policyType || policyType.enabled === false) {
    return { unlimited: false, entitled: 0, available: 0, source: 'none', proRated: false };
  }
  const days = num(policyType.days);
  if (policyType.grant === 'unlimited' || days === null) {
    return { unlimited: true, entitled: null, available: null, source: 'policy', proRated: false };
  }

  let entitled = days;
  let proRated = false;
  // Per-event types (maternity, paternity) are a statutory allowance per
  // event, not a yearly one — a July joiner still gets the full 90 days.
  if (proRate && policyType.grant !== 'per_event') {
    const months = monthsEmployedIn(year, employment);
    if (months < 12) {
      entitled = quarter((days * months) / 12);
      proRated = true;
    }
  }

  let available = entitled;
  if (policyType.grant === 'monthly' && asOf) {
    available = quarter((entitled * monthsAccrued(year, asOf, employment)) / 12);
  }
  return { unlimited: false, entitled, available, source: 'policy', proRated };
};

/**
 * Months accrued by `asOf` for monthly accrual: whole calendar months elapsed
 * since the later of 1 January and the start date, with the current month
 * counting once it has ended. Kept deliberately simple — HR sees the number.
 */
const monthsAccrued = (year, asOf, { startDate } = {}) => {
  const from = startDate ? new Date(Math.max(toUtcDate(startDate), yearStart(year))) : yearStart(year);
  const at = new Date(Math.min(toUtcDate(asOf), yearEnd(year)));
  if (at < from) return 0;
  let months = (at.getUTCFullYear() - from.getUTCFullYear()) * 12 + (at.getUTCMonth() - from.getUTCMonth());
  if (isLastDayOfMonth(at)) months += 1;
  return Math.max(0, Math.min(12, months));
};

/**
 * Days carried into this year.
 * HR's override wins; otherwise what was left last year, capped, never negative.
 */
const carriedIn = ({ prevRemaining, carryCap, overrideCarried } = {}) => {
  const override = num(overrideCarried);
  if (override !== null) return Math.max(0, override);
  const left = num(prevRemaining) ?? 0;
  const cap = num(carryCap) ?? 0;
  return round2(Math.max(0, Math.min(left, cap)));
};

/**
 * The balance picture for every type.
 *
 * @param {object} args
 * @param {number}  args.year
 * @param {string}  args.asOf              YYYY-MM-DD (today, from the caller)
 * @param {object[]} args.types            [{ key, name }]
 * @param {object}  args.policy            { carryExpiry:'MM-DD'|null, proRate, allowNegative, visibleTypes:[keys]|null }
 * @param {object}  args.policyTypes       { [key]: LeavePolicyType-like }
 * @param {object}  args.overrides         { [key]: { entitled, carriedOver } }
 * @param {object}  args.carried           { [key]: number } days carried in (from carriedIn())
 * @param {object[]} args.charges          [{ leaveType, days, startDate, state: 'taken'|'booked' }]
 *                                         taken = approved; booked = still pending
 * @param {object}  args.employment        { startDate, endDate }
 */
const summarise = ({
  year, asOf, types = [], policy = {}, policyTypes = {}, overrides = {}, carried = {}, charges = [], employment = {},
} = {}) => {
  const expiry = policy.carryExpiry ? toUtcDate(`${year}-${policy.carryExpiry}`) : null;
  const expired = expiry && asOf ? toUtcDate(asOf) > expiry : false;
  const visible = Array.isArray(policy.visibleTypes) ? new Set(policy.visibleTypes) : null;

  return types.map(({ key, name }) => {
    const ent = entitlementFor({
      policyType: policyTypes[key], override: overrides[key], employment, year, asOf, proRate: !!policy.proRate,
    });
    // `carried` is already the carried-in figure (carriedIn() applied the cap);
    // HR's override for this year still wins over it.
    const overrideCarried = num(overrides[key]?.carriedOver);
    const cIn = round2(Math.max(0, overrideCarried !== null ? overrideCarried : (num(carried[key]) ?? 0)));

    const mine = charges.filter((c) => c.leaveType === key);
    const takenRows = mine.filter((c) => c.state === 'taken')
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    const taken = round2(takenRows.reduce((s, c) => s + (num(c.days) || 0), 0));
    const booked = round2(mine.filter((c) => c.state === 'booked').reduce((s, c) => s + (num(c.days) || 0), 0));

    // FIFO: carried days are used by leave that starts on or before expiry.
    const usableFromCarry = expiry
      ? takenRows.filter((c) => toUtcDate(c.startDate) <= expiry).reduce((s, c) => s + (num(c.days) || 0), 0)
      : taken;
    const carriedUsed = round2(Math.min(cIn, usableFromCarry));
    const carriedLapsed = expired ? round2(cIn - carriedUsed) : 0;
    const carriedLeft = round2(cIn - carriedUsed - carriedLapsed);

    const remaining = ent.unlimited ? null : round2(ent.available + cIn - carriedLapsed - taken);

    return {
      leaveType: key,
      name: name || key,
      visible: visible ? visible.has(key) : true,
      unlimited: ent.unlimited,
      source: ent.source,
      proRated: ent.proRated,
      entitled: ent.entitled,
      available: ent.available,
      carriedIn: cIn,
      carriedUsed,
      carriedLapsed,
      carriedLeft,
      carryExpires: expiry && cIn > 0 && !expired ? `${year}-${policy.carryExpiry}` : null,
      taken,
      booked,
      remaining,
      remainingAfterBooked: remaining === null ? null : round2(remaining - booked),
    };
  });
};

/**
 * Can these charges be taken from these balances?
 * `summary` is summarise()'s output; `charges` is [{ leaveType, days }].
 * Refused only when the policy does not allow a negative balance.
 *
 * @returns {{ ok: boolean, short: { [key]: number } }}
 */
const checkBalance = ({ summary = [], charges = [], allowNegative = false } = {}) => {
  if (allowNegative) return { ok: true, short: {} };
  const byType = new Map(summary.map((s) => [s.leaveType, s]));
  const short = {};
  for (const c of charges) {
    const s = byType.get(c.leaveType);
    if (!s || s.unlimited) continue;
    const after = round2(s.remainingAfterBooked - (num(c.days) || 0));
    if (after < 0) short[c.leaveType] = round2(-after);
  }
  return { ok: Object.keys(short).length === 0, short };
};

module.exports = {
  entitlementFor,
  carriedIn,
  summarise,
  checkBalance,
  monthsEmployedIn,
  monthsAccrued,
};
