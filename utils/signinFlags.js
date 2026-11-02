// =====================================================================
// When is a sign-in suspicious? Pure — the database reads that gather a
// person's history live in services/signinLog.js; this file only decides.
// Sign-in tracking (16 Oct 2026, Emu).
//
// Reasons (stored comma-separated on UserLoginLogs.flagReasons):
//   new_device      a device label this person has not signed in from before
//   new_country     a country this person has not signed in from before
//   outside_clinic  not on one of the clinic's networks
//   outside_hours   outside the expected sign-in hours for that weekday
//   failed_attempts N wrong passwords on one account within M minutes
//
// The FIRST sign-in recorded with a device label is a person's baseline, not a
// new device: the release that starts recording devices would otherwise flag
// every member of staff on their first morning.
// =====================================================================

const { clinicToday, clinicClockTime } = require('./clinicTime');
const { weekdayOf } = require('./workHours');

const REASON_LABELS = {
  new_device: 'a device not used before',
  new_country: 'a country not signed in from before',
  outside_clinic: 'outside the clinic network',
  outside_hours: 'outside the expected sign-in hours',
  failed_attempts: 'repeated wrong passwords',
};

/** Clinic weekday (0 = Sunday) and 'HH:MM' for an instant. */
const clinicMoment = (at = new Date()) => ({
  weekday: weekdayOf(clinicToday(at)),
  time: clinicClockTime({ hour12: false, hourCycle: 'h23' }, at).replace(/^24/, '00'),
});

/** Is this instant outside the expected hours ({0..6: [start,end] | 'off'})? */
const isOutsideHours = (hours, at = new Date()) => {
  const { weekday, time } = clinicMoment(at);
  const day = hours?.[weekday];
  if (day === 'off' || !Array.isArray(day)) return true;
  return time < day[0] || time >= day[1];
};

/**
 * The reasons a SUCCESSFUL sign-in is flagged.
 *
 * @param {object} opts
 * @param {object} opts.signin   { deviceLabel, countryCode, network, loginAt }
 * @param {object} opts.history  { hasBaseline, devices: Set, countries: Set }
 *                               — this person's EARLIER successful sign-ins
 * @param {object} opts.rules    utils/signinSecurityConfig rules
 * @param {object} opts.hours    utils/signinSecurityConfig hours
 */
const successReasons = ({ signin, history, rules, hours }) => {
  const reasons = [];
  if (rules.newDevice && history.hasBaseline && signin.deviceLabel && !history.devices.has(signin.deviceLabel)) {
    reasons.push('new_device');
  }
  if (rules.newCountry && signin.countryCode && history.countries.size > 0 && !history.countries.has(signin.countryCode)) {
    reasons.push('new_country');
  }
  if (rules.outsideClinic && signin.network === 'outside') reasons.push('outside_clinic');
  if (rules.outsideHours && isOutsideHours(hours, signin.loginAt ? new Date(signin.loginAt) : new Date())) {
    reasons.push('outside_hours');
  }
  return reasons;
};

/**
 * Does this FAILED attempt complete a burst? True only on the attempt that
 * reaches the count, so one burst raises one alert rather than one per try.
 */
const failedBurstReached = ({ rules, recentFailures }) =>
  !!rules.failedAttempts && recentFailures === rules.failedCount;

const describeReasons = (reasons = []) => reasons.map((r) => REASON_LABELS[r] || r).join('; ');

module.exports = { successReasons, failedBurstReached, isOutsideHours, describeReasons, REASON_LABELS, clinicMoment };
