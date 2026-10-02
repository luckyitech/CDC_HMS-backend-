const db = require('../models');
const { parseHoursDefault } = require('./workHours');
const { DEFAULT_TARGETS, cleanTargets } = require('./cpd');
const { cleanThresholds, DEFAULT_THRESHOLDS } = require('./expiry');

const { Setting } = db;

// ---------------------------------------------------------------------------
// HR Suite — check-in rules and clinic-wide working hours, in the Setting
// table. Same read-with-cache + DEFAULTS pattern as utils/labInboxConfig.js
// and utils/commsConfig.js. No secrets live here in phase 1 (the reception
// fallback code was not built: every phone has NFC), so nothing is encrypted
// and getHrConfig() is safe to return to an HR user as-is.
//
// B27 phase 5 adds three more settings here (still area 'HR Suite'): CPD
// targets per cadre, expiry-reminder thresholds, and which leave types the team
// calendar shows non-managers by name.
//
// Every write is audited by the controller through
// services/settingChangeLog.js recordSettingChanges (area 'HR Suite').
// ---------------------------------------------------------------------------

const K = {
  debounceSeconds:      'hr.checkin.debounceSeconds',
  minSessionMinutes:    'hr.checkin.minSessionMinutes',
  autoCheckin:          'hr.checkin.autoCheckin',
  confirmCheckout:      'hr.checkin.confirmCheckout',
  geo:                  'hr.checkin.geo',              // 'off' | 'log'
  hoursDefault:         'hr.hours.default',            // JSON, see utils/workHours.js parseHoursDefault
  graceMinutes:         'hr.punctuality.graceMinutes',
  positiveFeedback:     'hr.punctuality.positiveFeedback',
  deviceDays:           'hr.devices.expiryDays',
  alerts:               'hr.alerts',                   // JSON, see ALERT_EVENTS below (B27)
  // B27 phase 5
  cpdTargets:           'hr.cpd.targets',              // JSON { doctor, nurse, lab, staff }
  cpdPeriodStart:       'hr.cpd.periodStart',          // 'MM-DD' — reset day (calendar year: 01-01)
  expiryThresholds:     'hr.expiry.thresholds',        // JSON [60,30,7,0]
  calendarVisibleTypes: 'hr.calendar.visibleTypes',    // JSON [leave type keys]
  // HR Tier 2 (2 Oct 2026): a holiday on a Sunday is also observed on the next
  // day that isn't a holiday ('auto' PublicHolidays rows). Off = those rows are
  // ignored everywhere (leaveService), not deleted.
  observeSundayHolidays: 'hr.holidays.observeSunday', // 'true' | 'false'
};

// B27 (decision D9): which HR alerts go out on which channel. HR chooses per
// event × channel. The person's own Leave tab always shows everything — that
// is not a channel you can switch off. WhatsApp stays off (and greyed in the
// UI) until the HMS WhatsApp number is registered (B18).
const ALERT_EVENTS = [
  'leave_to_approve', 'leave_decided', 'leave_info_requested', 'leave_info_replied',
  'leave_acknowledge', 'leave_cancelled', 'change_request_decided', 'expiry_self', 'expiry_hr',
  // 2 Oct 2026 (B27 debt): tell hr.profile.approve holders a change request is waiting.
  'change_request_new',
  // HR Tier 2: the cover person is asked; the applicant hears their answer.
  'leave_cover_request', 'leave_cover_answered',
];
const ALERT_CHANNELS = ['bell', 'email', 'whatsapp'];
const DEFAULT_ALERTS = Object.fromEntries(ALERT_EVENTS.map((e) => [e, { bell: true, email: true, whatsapp: false }]));

/** A stored alerts value, completed with defaults so every event × channel has an answer. */
const normaliseAlerts = (value) => {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  const out = {};
  for (const event of ALERT_EVENTS) {
    const row = parsed && typeof parsed === 'object' ? parsed[event] : null;
    out[event] = {};
    for (const ch of ALERT_CHANNELS) {
      out[event][ch] = row && typeof row[ch] === 'boolean' ? row[ch] : DEFAULT_ALERTS[event][ch];
    }
  }
  return out;
};

const safeParse = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

// Team-calendar visible leave types (phase 5). Sick and any private type are
// LOCKED private (health data) and stripped here as well as at read in the
// calendar controller — leaveService.PRIVATE_TYPES is the source of truth;
// this small mirror avoids a circular require (leaveService requires hrConfig).
const LOCKED_CALENDAR_TYPES = new Set(['Sick']);
const cleanVisibleTypes = (value) => {
  const arr = safeParse(value);
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((k) => String(k).slice(0, 40)).filter((k) => k && !LOCKED_CALENDAR_TYPES.has(k)))];
};

const DEFAULTS = {
  debounceSeconds: 120,
  minSessionMinutes: 10,
  autoCheckin: true,
  confirmCheckout: true,
  geo: 'log',
  // Decided with Emu, 23 Sep 2026: Mon–Fri 08:00–17:00, Sat 08:00–13:00, Sun off.
  hoursDefault: { '1-5': ['08:00', '17:00'], 6: ['08:00', '13:00'], 0: 'off' },
  graceMinutes: 0,
  positiveFeedback: true,
  deviceDays: 90,
  alerts: DEFAULT_ALERTS,
  // Phase 5. CPD is counted per calendar year (Emu, 29 Sep). Visible types
  // defaults to EMPTY: until HR ticks a type, everyone without leave.manage sees
  // only "Away" (names and dates), which is the most private starting point.
  cpdTargets: DEFAULT_TARGETS,
  cpdPeriodStart: '01-01',
  expiryThresholds: DEFAULT_THRESHOLDS,
  calendarVisibleTypes: [],
  observeSundayHolidays: true,
};

const GEO_MODES = ['off', 'log'];

// The audit labels, shared by the controller so the fields map is written once.
const FIELDS = {
  debounceSeconds:      { key: K.debounceSeconds,      label: 'Ignore repeat taps within (seconds)' },
  minSessionMinutes:    { key: K.minSessionMinutes,    label: 'Shortest session counted (minutes)' },
  autoCheckin:          { key: K.autoCheckin,          label: 'First tap checks in immediately' },
  confirmCheckout:      { key: K.confirmCheckout,      label: 'Check-out asks for confirmation' },
  geo:                  { key: K.geo,                  label: 'Phone location' },
  hoursDefault:         { key: K.hoursDefault,         label: 'Clinic-wide default hours' },
  graceMinutes:         { key: K.graceMinutes,         label: 'Grace (minutes)' },
  positiveFeedback:     { key: K.positiveFeedback,     label: 'Positive feedback on tap' },
  deviceDays:           { key: K.deviceDays,           label: 'Remembered phones expire after (days)' },
  alerts:               { key: K.alerts,               label: 'HR alert channels' },
  cpdTargets:           { key: K.cpdTargets,           label: 'CPD targets (points per year)' },
  cpdPeriodStart:       { key: K.cpdPeriodStart,       label: 'CPD period start' },
  expiryThresholds:     { key: K.expiryThresholds,     label: 'Expiry reminder days' },
  calendarVisibleTypes: { key: K.calendarVisibleTypes, label: 'Team calendar — visible leave types' },
  observeSundayHolidays: { key: K.observeSundayHolidays, label: 'Holiday on a Sunday also observed on the next day' },
};

let cached = { rows: null, at: 0 };
const CACHE_MS = 15 * 1000;
const clearHrCache = () => { cached = { rows: null, at: 0 }; };

const readRows = async () => {
  if (cached.rows && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const rows = await Setting.findAll({ where: { key: Object.values(K) } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cached = { rows: map, at: Date.now() };
  return map;
};

const bool = (v, d) => (v === undefined ? d : v === 'true');
const int = (v, d, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
};

const getHrConfig = async () => {
  const m = await readRows();
  let hoursDefault = DEFAULTS.hoursDefault;
  if (m[K.hoursDefault]) {
    try { const parsed = JSON.parse(m[K.hoursDefault]); if (parsed && typeof parsed === 'object') hoursDefault = parsed; } catch { /* keep default */ }
  }
  return {
    debounceSeconds:   int(m[K.debounceSeconds], DEFAULTS.debounceSeconds, 0, 3600),
    minSessionMinutes: int(m[K.minSessionMinutes], DEFAULTS.minSessionMinutes, 0, 720),
    autoCheckin:       bool(m[K.autoCheckin], DEFAULTS.autoCheckin),
    confirmCheckout:   bool(m[K.confirmCheckout], DEFAULTS.confirmCheckout),
    geo:               GEO_MODES.includes(m[K.geo]) ? m[K.geo] : DEFAULTS.geo,
    hoursDefault,
    graceMinutes:      int(m[K.graceMinutes], DEFAULTS.graceMinutes, 0, 240),
    positiveFeedback:  bool(m[K.positiveFeedback], DEFAULTS.positiveFeedback),
    deviceDays:        int(m[K.deviceDays], DEFAULTS.deviceDays, 1, 3650),
    alerts:            normaliseAlerts(m[K.alerts]),
    cpdTargets:        cleanTargets(m[K.cpdTargets]) || { ...DEFAULT_TARGETS },
    cpdPeriodStart:    /^\d{2}-\d{2}$/.test(m[K.cpdPeriodStart] || '') ? m[K.cpdPeriodStart] : DEFAULTS.cpdPeriodStart,
    expiryThresholds:  cleanThresholds(safeParse(m[K.expiryThresholds])) || [...DEFAULT_THRESHOLDS],
    calendarVisibleTypes: cleanVisibleTypes(m[K.calendarVisibleTypes]),
    observeSundayHolidays: bool(m[K.observeSundayHolidays], DEFAULTS.observeSundayHolidays),
  };
};

/** Validate and write whichever fields are passed; the rest are untouched. */
const setHrConfig = async (changes = {}) => {
  const write = async (key, value) => {
    const v = value == null ? '' : String(value);
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value: v } });
    if (!created && row.value !== v) await row.update({ value: v });
  };
  const num = (name, min, max) => {
    const n = parseInt(changes[name], 10);
    if (Number.isNaN(n) || n < min || n > max) throw new Error(`${FIELDS[name].label} must be between ${min} and ${max}.`);
    return n;
  };

  if (changes.debounceSeconds !== undefined)   await write(K.debounceSeconds, num('debounceSeconds', 0, 3600));
  if (changes.minSessionMinutes !== undefined) await write(K.minSessionMinutes, num('minSessionMinutes', 0, 720));
  if (changes.graceMinutes !== undefined)      await write(K.graceMinutes, num('graceMinutes', 0, 240));
  if (changes.deviceDays !== undefined)        await write(K.deviceDays, num('deviceDays', 1, 3650));
  if (changes.autoCheckin !== undefined)       await write(K.autoCheckin, changes.autoCheckin ? 'true' : 'false');
  if (changes.confirmCheckout !== undefined)   await write(K.confirmCheckout, changes.confirmCheckout ? 'true' : 'false');
  if (changes.positiveFeedback !== undefined)  await write(K.positiveFeedback, changes.positiveFeedback ? 'true' : 'false');
  if (changes.geo !== undefined) {
    if (!GEO_MODES.includes(changes.geo)) throw new Error(`Phone location must be one of ${GEO_MODES.join(', ')}.`);
    await write(K.geo, changes.geo);
  }
  if (changes.hoursDefault !== undefined) {
    const parsed = parseHoursDefault(changes.hoursDefault);
    if (!Object.keys(parsed).length) throw new Error('Clinic-wide default hours must name at least one weekday, e.g. {"1-5":["08:00","17:00"],"6":["08:00","13:00"],"0":"off"}.');
    const obj = typeof changes.hoursDefault === 'string' ? JSON.parse(changes.hoursDefault) : changes.hoursDefault;
    await write(K.hoursDefault, JSON.stringify(obj));
  }

  if (changes.alerts !== undefined) {
    const obj = typeof changes.alerts === 'string' ? JSON.parse(changes.alerts) : changes.alerts;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('HR alert channels must be an object of events.');
    const unknown = Object.keys(obj).filter((e) => !ALERT_EVENTS.includes(e));
    if (unknown.length) throw new Error(`Each HR alert must be one of the known events (unknown: ${unknown[0]}).`);
    await write(K.alerts, JSON.stringify(normaliseAlerts(obj)));
  }

  // ---- Phase 5 -------------------------------------------------------------
  if (changes.cpdTargets !== undefined) {
    const t = cleanTargets(changes.cpdTargets);
    if (!t) throw new Error('CPD targets must be a number of points for each cadre.');
    await write(K.cpdTargets, JSON.stringify(t));
  }
  if (changes.cpdPeriodStart !== undefined) {
    if (!/^\d{2}-\d{2}$/.test(String(changes.cpdPeriodStart))) throw new Error('CPD period start must be MM-DD.');
    await write(K.cpdPeriodStart, String(changes.cpdPeriodStart));
  }
  if (changes.expiryThresholds !== undefined) {
    const arr = typeof changes.expiryThresholds === 'string' ? safeParse(changes.expiryThresholds) : changes.expiryThresholds;
    const clean = cleanThresholds(arr);
    if (!clean) throw new Error('Expiry reminder days must be one or more whole numbers of days.');
    await write(K.expiryThresholds, JSON.stringify(clean));
  }
  if (changes.observeSundayHolidays !== undefined) {
    await write(K.observeSundayHolidays, changes.observeSundayHolidays ? 'true' : 'false');
  }
  if (changes.calendarVisibleTypes !== undefined) {
    const arr = typeof changes.calendarVisibleTypes === 'string' ? safeParse(changes.calendarVisibleTypes) : changes.calendarVisibleTypes;
    if (!Array.isArray(arr)) throw new Error('Team calendar visible types must be a list of leave types.');
    await write(K.calendarVisibleTypes, JSON.stringify(cleanVisibleTypes(JSON.stringify(arr))));
  }

  clearHrCache();
  return getHrConfig();
};

module.exports = {
  KEYS: K, DEFAULTS, FIELDS, GEO_MODES, ALERT_EVENTS, ALERT_CHANNELS, normaliseAlerts,
  getHrConfig, setHrConfig, clearHrCache,
};
