// Leave policy settings — the rules HR's Leave settings screen is held to.
//
// B27 phase 1 (spec §3.2, §6, §11; decisions D1–D4, D10). Pure: no database,
// no clock (the caller passes the clinic's `today`). The controller
// (controllers/leaveSettingsController.js) loads rows, asks these functions,
// and writes what they return — so the screen and the API cannot disagree
// about what a valid policy is.
//
// Three things live here:
//   validatePolicy   — a policy body from the screen → clean values or errors
//   editability      — may this year's policy still be changed / published?
//   typeKeyFor       — the stored key for a new leave type HR adds by name
//
// Why a year that has ended is frozen: balances are computed on read from the
// year's policy (utils/leaveBalance). Editing a finished year's policy would
// silently restate every past balance — and next year's carry-in with it. A
// one-person correction for a past year is an override on the entitlement
// grid, which is recorded with a reason.

const WEEKDAY_VALUES = [0, 0.5, 1];
const COUNTING_MODES = ['clinic_week', 'own_hours'];
const COUNTED_AS = ['working', 'calendar'];
const GRANTS = ['up_front', 'monthly', 'per_event', 'unlimited'];
const DOC_RULES = ['never', 'always', 'over_days'];
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// The furthest ahead HR may prepare a policy. The seed makes this year and
// next; two ahead is room for planning without inviting typos like 2207.
const YEARS_AHEAD = 2;

const round2 = (n) => Math.round(n * 100) / 100;

/** A number from the form, or null for blank. NaN stays NaN so it can be refused. */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : Number(String(v).trim());
};

/** Is 'MM-DD' a real calendar day (29 Feb allowed — it exists in leap years)? */
const isMonthDay = (s) => {
  if (typeof s !== 'string' || !MMDD.test(s)) return false;
  const [m, d] = s.split('-').map(Number);
  return d <= DAYS_IN_MONTH[m - 1];
};

/**
 * May the policy for `year` be edited or published today?
 *
 * @param {object} args
 * @param {number} args.year
 * @param {string} args.today           clinic date 'YYYY-MM-DD'
 * @param {object|null} args.policy     { status } or null when none exists
 * @returns {{ canEdit: boolean, canPublish: boolean, canCreate: boolean,
 *             code: string|null, reason: string|null, ended: boolean }}
 */
const editability = ({ year, today, policy }) => {
  const thisYear = Number(String(today).slice(0, 4));
  const ended = year < thisYear;
  const tooFar = year > thisYear + YEARS_AHEAD;
  if (ended) {
    return {
      canEdit: false, canPublish: false, canCreate: false, ended, code: 'POLICY_YEAR_ENDED',
      reason: `${year} has ended, so its leave policy can no longer be changed — past balances would change with it. `
        + 'Correct one person with an override on Staff entitlements instead.',
    };
  }
  if (tooFar) {
    return {
      canEdit: false, canPublish: false, canCreate: false, ended, code: 'POLICY_YEAR_TOO_FAR',
      reason: `Policies can be prepared up to ${thisYear + YEARS_AHEAD}.`,
    };
  }
  if (!policy) return { canEdit: false, canPublish: false, canCreate: true, ended, code: 'NO_POLICY', reason: null };
  return {
    canEdit: true,
    canPublish: policy.status === 'draft',
    canCreate: false,
    ended,
    code: null,
    reason: null,
  };
};

/**
 * Validate a policy body from the Leave settings screen.
 *
 * @param {object} body         { weekWeights, countingMode, allowNegative, proRate,
 *                                carryExpiry, minNoticeDays, maxCadreAwayPerDay,
 *                                blockDoctorSlots, visibleTypes, types: { [key]: row } }
 * @param {object} ctx
 * @param {string[]} ctx.activeKeys   keys of active LeaveTypes
 * @returns {{ ok: boolean, errors: string[], value: object }}
 *   `value.types` holds a clean row for every key the body sent (only active keys).
 */
const validatePolicy = (body = {}, { activeKeys = [] } = {}) => {
  const errors = [];
  const value = {};
  const active = new Set(activeKeys);

  // ---- Weekday values (D3) --------------------------------------------------
  const ww = body.weekWeights;
  if (!ww || typeof ww !== 'object' || Array.isArray(ww)) {
    errors.push('Each weekday needs a value (1, ½ or 0).');
  } else {
    value.weekWeights = {};
    for (let d = 0; d <= 6; d++) {
      const v = numOrNull(ww[d] ?? ww[String(d)]);
      if (v === null || !WEEKDAY_VALUES.includes(v)) {
        errors.push(`${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]} must be worth 1, ½ or 0.`);
      } else value.weekWeights[d] = v;
    }
    if (value.weekWeights && Object.keys(value.weekWeights).length === 7
      && Object.values(value.weekWeights).every((v) => v === 0)) {
      errors.push('At least one weekday must count — otherwise no leave would ever cost a day.');
    }
  }

  // ---- Counting and rules ------------------------------------------------------
  value.countingMode = body.countingMode ?? 'clinic_week';
  if (!COUNTING_MODES.includes(value.countingMode)) errors.push('Counting must be the clinic week or each person\'s own hours.');

  value.allowNegative = !!body.allowNegative;
  value.proRate = body.proRate === undefined ? true : !!body.proRate;
  value.blockDoctorSlots = body.blockDoctorSlots === undefined ? true : !!body.blockDoctorSlots;
  // D3: public holidays are never counted. The screen shows it locked on;
  // the API keeps it that way whatever is sent.
  value.excludeHolidays = true;

  const ce = body.carryExpiry;
  if (ce === null || ce === undefined || ce === '') value.carryExpiry = null;
  else if (!isMonthDay(ce)) errors.push('Carried days must expire on a real date (MM-DD), or never.');
  else value.carryExpiry = ce;

  const notice = numOrNull(body.minNoticeDays);
  if (notice === null) value.minNoticeDays = 0;
  else if (!Number.isInteger(notice) || notice < 0 || notice > 365) errors.push('Minimum notice must be between 0 and 365 days.');
  else value.minNoticeDays = notice;

  const cadre = numOrNull(body.maxCadreAwayPerDay);
  if (cadre === null) value.maxCadreAwayPerDay = null;
  else if (!Number.isInteger(cadre) || cadre < 1 || cadre > 50) errors.push('Staff of one cadre away on the same day must be between 1 and 50, or blank for no warning.');
  else value.maxCadreAwayPerDay = cadre;

  // ---- Visible types (D10) -----------------------------------------------------
  if (body.visibleTypes !== undefined) {
    if (!Array.isArray(body.visibleTypes)) errors.push('Visible leave types must be a list.');
    else {
      const unknown = body.visibleTypes.find((k) => !active.has(k));
      if (unknown !== undefined) errors.push(`"${unknown}" is not an active leave type.`);
      else value.visibleTypes = [...new Set(body.visibleTypes)];
    }
  }

  // ---- Per-type rows (D1, D2) ----------------------------------------------------
  value.types = {};
  const types = body.types && typeof body.types === 'object' && !Array.isArray(body.types) ? body.types : {};
  for (const [key, row] of Object.entries(types)) {
    if (!active.has(key)) { errors.push(`"${key}" is not an active leave type.`); continue; }
    const r = row || {};
    const name = r.name || key;
    const clean = {};

    clean.enabled = r.enabled === undefined ? true : !!r.enabled;
    clean.grant = r.grant ?? 'up_front';
    if (!GRANTS.includes(clean.grant)) { errors.push(`${name}: how it is granted must be up front, monthly, per event or no limit.`); continue; }
    clean.countedAs = r.countedAs ?? 'working';
    if (!COUNTED_AS.includes(clean.countedAs)) errors.push(`${name}: must be counted in working or calendar days.`);

    const days = numOrNull(r.days);
    if (clean.grant === 'unlimited') {
      clean.days = null;
    } else if (days === null || Number.isNaN(days)) {
      errors.push(`${name}: enter the number of days (or choose "No limit").`);
    } else if (days < 0 || days > 366) {
      errors.push(`${name}: days must be between 0 and 366.`);
    } else if (Math.round(days * 4) !== days * 4) {
      errors.push(`${name}: days must be whole, half or quarter days.`);
    } else clean.days = round2(days);

    // Carry-over only means something for a yearly allowance.
    const cap = numOrNull(r.carryCap);
    if (clean.grant === 'up_front' || clean.grant === 'monthly') {
      if (cap === null) clean.carryCap = 0;
      else if (Number.isNaN(cap) || cap < 0 || cap > 366) errors.push(`${name}: carry cap must be between 0 and 366 days.`);
      else if (clean.days !== undefined && clean.days !== null && cap > clean.days) errors.push(`${name}: carry cap cannot be more than the yearly allowance.`);
      else clean.carryCap = round2(cap);
    } else clean.carryCap = 0;

    clean.halfDaysAllowed = !!r.halfDaysAllowed;
    if (clean.countedAs === 'calendar' && clean.halfDaysAllowed) {
      errors.push(`${name}: half days are not possible for leave counted in calendar days.`);
    }

    clean.docRule = r.docRule ?? 'never';
    if (!DOC_RULES.includes(clean.docRule)) errors.push(`${name}: "needs a document" must be never, always or over a number of days.`);
    const over = numOrNull(r.docOverDays);
    if (clean.docRule === 'over_days') {
      if (over === null || Number.isNaN(over) || over <= 0 || over > 366) errors.push(`${name}: say after how many days a document is needed.`);
      else clean.docOverDays = round2(over);
    } else clean.docOverDays = null;

    const typeNotice = numOrNull(r.minNoticeDays);
    if (typeNotice === null) clean.minNoticeDays = null;
    else if (!Number.isInteger(typeNotice) || typeNotice < 0 || typeNotice > 365) errors.push(`${name}: notice must be between 0 and 365 days, or blank to use the clinic's.`);
    else clean.minNoticeDays = typeNotice;

    value.types[key] = clean;
  }

  return { ok: errors.length === 0, errors, value };
};

/**
 * What must be true before a year is published.
 * @param {object} policy   loadPolicy()-shaped: { types: { [key]: row }, visibleTypes }
 * @param {string[]} activeKeys
 * @returns {string[]} problems (empty = can publish)
 */
const publishProblems = (policy, activeKeys = []) => {
  const problems = [];
  const types = policy?.types || {};
  const enabled = activeKeys.filter((k) => types[k] && types[k].enabled);
  if (!enabled.length) problems.push('At least one leave type must be switched on.');
  const visible = Array.isArray(policy?.visibleTypes) ? policy.visibleTypes : activeKeys;
  if (!visible.some((k) => enabled.includes(k))) problems.push('Staff must be able to see at least one leave type that is switched on.');
  for (const k of activeKeys) {
    const t = types[k];
    if (t && t.enabled && t.grant !== 'unlimited' && (t.days === null || t.days === undefined)) {
      problems.push(`${k} has no number of days.`);
    }
  }
  return problems;
};

/**
 * The stored key for a leave type HR adds by name: letters and digits in
 * PascalCase ("Sabbatical", "Hajj leave" → "HajjLeave"), unique among
 * `existing`, at most 40 characters. Keys never change once stored.
 * @returns {string|null} null when the name has no usable letters.
 */
const typeKeyFor = (name, existing = []) => {
  const words = String(name || '').normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const base = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 36);
  if (!base || !/^[A-Za-z]/.test(base)) return null;
  const taken = new Set(existing.map((k) => String(k).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const k = `${base}${i}`;
    if (!taken.has(k.toLowerCase())) return k;
  }
  return null;
};

/**
 * Clean a per-person week (D3 override) — { "0".."6": 1|0.5|0 } or null.
 * @returns {{ ok: boolean, value: object|null, error?: string }}
 */
const cleanWeek = (week) => {
  if (week === null || week === undefined || week === '') return { ok: true, value: null };
  if (typeof week !== 'object' || Array.isArray(week)) return { ok: false, value: null, error: 'The personal week must give each weekday a value.' };
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const v = numOrNull(week[d] ?? week[String(d)]);
    if (v === null || !WEEKDAY_VALUES.includes(v)) return { ok: false, value: null, error: 'Each day of the personal week must be worth 1, ½ or 0.' };
    out[d] = v;
  }
  if (Object.values(out).every((v) => v === 0)) return { ok: false, value: null, error: 'A personal week needs at least one working day.' };
  return { ok: true, value: out };
};

module.exports = {
  WEEKDAY_VALUES,
  COUNTING_MODES,
  COUNTED_AS,
  GRANTS,
  DOC_RULES,
  YEARS_AHEAD,
  isMonthDay,
  editability,
  validatePolicy,
  publishProblems,
  typeKeyFor,
  cleanWeek,
};
