// Applying for leave — the checks that decide whether a request may be made
// and what the applicant should be warned about. B27 phase 2 (Apply).
//
// Pure: the controller (controllers/hrSelfLeaveController.js) loads the year's
// policy, the leave types and the colleagues who are away, and asks these
// functions. The preview and the submit call the SAME evaluate() in the
// controller, which calls these — so what the wizard shows is exactly what the
// submit will accept or refuse.
//
// Emu's rulings (28 Sep 2026):
//   - any type may be BACKDATED — flagged, never refused;
//   - a type that needs a document can be submitted with it OWED;
//   - before a year's policy is published every active type is offered and the
//     old counting applies (the balance is shown but never blocks);
//   - a request may not cross 31 December (Claude, stated to Emu): each year
//     has its own policy and balance, so the applicant makes two requests.

const { toUtcDate, datesInRange, rangesOverlap } = require('./leaveCalc');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// What the applicant reads. Errors block; warnings don't.
const MESSAGES = {
  BAD_TYPE:           'Choose a leave type.',
  BAD_DATE:           'Choose the dates.',
  CROSSES_YEAR:       'A request cannot run past 31 December — make one request for each year.',
  TYPE_OFF:           'That leave type is not in use this year.',
  TYPE_NOT_OFFERED:   'That leave type is not one you can apply for — ask HR to record it.',
  END_BEFORE_START:   'The last day must be on or after the first day.',
  HALF_DAYS_NEED_POLICY: 'Half days can be requested once this year\'s leave policy is published.',
  HALF_DAYS_NOT_ALLOWED: 'This leave type is taken in whole days.',
  BAD_PART:           'A single day cannot both start after lunch and end at lunch.',
  ZERO_DAYS:          'Those dates are all days off or public holidays — there is nothing to take.',
  OVERLAP:            'You already have leave on some of these days.',
  INSUFFICIENT_BALANCE: 'You don\'t have enough days left for this.',
  // warnings
  BACKDATED:          'These dates are in the past — the request will be marked as backdated.',
  SHORT_NOTICE:       'This is less notice than the policy asks for. You can still apply.',
  DOCUMENT_NEEDED:    'This leave needs a supporting document. You can attach it now or add it later.',
  CLASH:              'Colleagues in your role are also away on some of these days.',
  OVER_LIMIT:         'More of your role would be away on some days than the clinic usually allows.',
  OVER_BALANCE:       'This takes the balance below zero. It will still be recorded.',
};

const yearOf = (iso) => Number(String(iso).slice(0, 4));

/** Whole days from `from` to `to` (to − from), both YYYY-MM-DD. */
const daysBetween = (from, to) => Math.round((toUtcDate(to) - toUtcDate(from)) / MS_PER_DAY);

/**
 * Which types can this person apply for in a year?
 *
 * @param {object[]} types      active LeaveTypes [{ key, name }]
 * @param {object|null} policy  the PUBLISHED policy (leaveService.loadPolicy) or null
 * @returns {string[]} keys
 */
const offeredKeys = (types = [], policy = null) => {
  if (!policy) return types.map((t) => t.key);
  const visible = Array.isArray(policy.visibleTypes) ? new Set(policy.visibleTypes) : null;
  return types
    .filter((t) => policy.types[t.key]?.enabled)
    .filter((t) => !visible || visible.has(t.key))
    .map((t) => t.key);
};

/** The notice a type asks for: its own, else the clinic's, else none. */
const noticeFor = (policy, key) => {
  if (!policy) return 0;
  const own = policy.types[key]?.minNoticeDays;
  if (own !== null && own !== undefined && own !== '') return Number(own) || 0;
  return Number(policy.minNoticeDays) || 0;
};

/** Does this request need a supporting document under the policy? */
const documentNeededFor = (policy, key, total) => {
  const pt = policy?.types?.[key];
  if (!pt) return false;
  if (pt.docRule === 'always') return true;
  if (pt.docRule === 'over_days') return Number(total) > (Number(pt.docOverDays) || 0);
  return false;
};

/**
 * The checks that don't need the day count.
 *
 * @param {object} args
 * @param {string} args.leaveType
 * @param {string} args.start      YYYY-MM-DD
 * @param {string} args.end        YYYY-MM-DD
 * @param {string} args.today      YYYY-MM-DD (clinic date, from the caller)
 * @param {object[]} args.types    active LeaveTypes [{ key, name }]
 * @param {object|null} args.policy  published policy or null
 * @returns {{ errors: string[], warnings: string[], notice: number, noticeGiven: number|null }}
 */
const applicationCheck = ({ leaveType, start, end, today, types = [], policy = null } = {}) => {
  const errors = [];
  const warnings = [];

  const known = types.some((t) => t.key === leaveType);
  if (!leaveType || !known) errors.push('BAD_TYPE');
  else if (policy && !policy.types[leaveType]?.enabled) errors.push('TYPE_OFF');
  else if (!offeredKeys(types, policy).includes(leaveType)) errors.push('TYPE_NOT_OFFERED');

  if (start && end && yearOf(start) !== yearOf(end)) errors.push('CROSSES_YEAR');

  const notice = noticeFor(policy, leaveType);
  let noticeGiven = null;
  if (start && today) {
    noticeGiven = daysBetween(today, start);
    if (noticeGiven < 0) warnings.push('BACKDATED');
    else if (notice > 0 && noticeGiven < notice) warnings.push('SHORT_NOTICE');
  }

  return { errors, warnings, notice, noticeGiven };
};

/**
 * Who else of the same role is away, by name and dates only — never the type
 * or reason (sick leave is health data).
 *
 * @param {object} args
 * @param {string} args.start
 * @param {string} args.end
 * @param {object[]} args.others   [{ userId, name, startDate, endDate }] — same role, not the applicant,
 *                                 live leave only (the caller filters statuses)
 * @param {number|null} args.maxPerDay  policy.maxCadreAwayPerDay (warn only)
 * @param {Set<string>|null} args.skipDates  dates that don't count (public holidays)
 * @returns {{ people: { name, from, to }[], overLimit: string[] }}
 */
const clashes = ({ start, end, others = [], maxPerDay = null, skipDates = null } = {}) => {
  const people = [];
  const awayOn = new Map();   // date → Set(userId)
  for (const o of others) {
    const s = String(o.startDate).slice(0, 10);
    const e = String(o.endDate).slice(0, 10);
    if (!rangesOverlap(start, end, s, e)) continue;
    const from = s > start ? s : start;
    const to = e < end ? e : end;
    people.push({ name: o.name, from, to });
    for (const d of datesInRange(from, to)) {
      if (!awayOn.has(d)) awayOn.set(d, new Set());
      awayOn.get(d).add(o.userId);
    }
  }
  people.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));

  const overLimit = [];
  const limit = maxPerDay === null || maxPerDay === undefined || maxPerDay === '' ? null : Number(maxPerDay);
  if (limit !== null && Number.isFinite(limit)) {
    for (const d of datesInRange(start, end)) {
      if (skipDates && skipDates.has(d)) continue;
      // The applicant counts as one.
      const count = (awayOn.get(d)?.size || 0) + 1;
      if (count > limit) overLimit.push(d);
    }
  }
  return { people, overLimit };
};

/** code → { code, message } for the screen. */
const describe = (code) => ({ code, message: MESSAGES[code] || code });

module.exports = {
  MESSAGES,
  offeredKeys,
  noticeFor,
  documentNeededFor,
  applicationCheck,
  clashes,
  describe,
  daysBetween,
};
