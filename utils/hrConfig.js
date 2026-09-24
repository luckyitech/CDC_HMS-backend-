const db = require('../models');
const { parseHoursDefault } = require('./workHours');

const { Setting } = db;

// ---------------------------------------------------------------------------
// HR Suite — check-in rules and clinic-wide working hours, in the Setting
// table. Same read-with-cache + DEFAULTS pattern as utils/labInboxConfig.js
// and utils/commsConfig.js. No secrets live here in phase 1 (the reception
// fallback code was not built: every phone has NFC), so nothing is encrypted
// and getHrConfig() is safe to return to an HR user as-is.
//
// Every write is audited by the controller through
// services/settingChangeLog.js recordSettingChanges (area 'HR Suite').
// ---------------------------------------------------------------------------

const K = {
  debounceSeconds:   'hr.checkin.debounceSeconds',
  minSessionMinutes: 'hr.checkin.minSessionMinutes',
  autoCheckin:       'hr.checkin.autoCheckin',
  confirmCheckout:   'hr.checkin.confirmCheckout',
  geo:               'hr.checkin.geo',              // 'off' | 'log'
  hoursDefault:      'hr.hours.default',            // JSON, see utils/workHours.js parseHoursDefault
  graceMinutes:      'hr.punctuality.graceMinutes',
  positiveFeedback:  'hr.punctuality.positiveFeedback',
  deviceDays:        'hr.devices.expiryDays',
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
};

const GEO_MODES = ['off', 'log'];

// The audit labels, shared by the controller so the fields map is written once.
const FIELDS = {
  debounceSeconds:   { key: K.debounceSeconds,   label: 'Ignore repeat taps within (seconds)' },
  minSessionMinutes: { key: K.minSessionMinutes, label: 'Shortest session counted (minutes)' },
  autoCheckin:       { key: K.autoCheckin,       label: 'First tap checks in immediately' },
  confirmCheckout:   { key: K.confirmCheckout,   label: 'Check-out asks for confirmation' },
  geo:               { key: K.geo,               label: 'Phone location' },
  hoursDefault:      { key: K.hoursDefault,      label: 'Clinic-wide default hours' },
  graceMinutes:      { key: K.graceMinutes,      label: 'Grace (minutes)' },
  positiveFeedback:  { key: K.positiveFeedback,  label: 'Positive feedback on tap' },
  deviceDays:        { key: K.deviceDays,        label: 'Remembered phones expire after (days)' },
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

  clearHrCache();
  return getHrConfig();
};

module.exports = { KEYS: K, DEFAULTS, FIELDS, GEO_MODES, getHrConfig, setHrConfig, clearHrCache };
