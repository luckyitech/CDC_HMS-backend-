// =====================================================================
// What the tap page says (HR Suite, B21) — the copy table from the signed-off
// mockup, in ONE place so HR can soften it or switch the mood lines off
// (hr.punctuality.positiveFeedback). The frontend renders what the server
// sends and never composes a line of its own.
//
// Tone rules (mockup decision 4): the person's REAL minutes, never a count
// of their red stars in the red line (the table has that), always a way
// forward.
// =====================================================================

const { clinicHHMM } = require('./attendanceRules');
const { CLINIC_TZ } = require('./clinicTime');

/** "Dr" for doctors, nothing otherwise (decided with Emu, 23 Sep). */
const titleFor = (user) => (user?.role === 'doctor' ? 'Dr' : '');
const greetName = (user) => `${titleFor(user)} ${user?.firstName || ''}`.trim();

const hoursAndMinutes = (minutes) => {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)} h ${m % 60} m`;
};

/**
 * @param {object} p
 * @param {'checked_in'|'offer_checkout'|'checked_out'|'duplicate'|'refused'|'not_enabled'} p.action
 * @param {object} p.user            { firstName, role }
 * @param {object} [p.session]       the session row (plain)
 * @param {{state,minutes}} [p.punct]  the punctuality just judged (in for checked_in, out for checked_out / offer)
 * @param {object} [p.month]         { lateCount, earlyOutCount, streakNoRed }
 * @param {Date}   p.now
 * @param {boolean} p.positiveFeedback
 * @param {'in'|'out'} [p.duplicateSide]
 * @returns {{ headline:string, mood:string|null, sub:string|null, facts:Array<[string,string]> }}
 */
const buildTapMessages = ({ action, user, session, punct, month = {}, now, positiveFeedback = true, duplicateSide }) => {
  const name = user?.firstName || '';
  const greet = greetName(user);
  const hhmm = clinicHHMM(now);
  // 'en-US' short months are three letters everywhere ('Sep'); en-GB says 'Sept'.
  const monthName = now.toLocaleDateString('en-US', { month: 'short', timeZone: CLINIC_TZ });
  const expectedIn = session?.expectedInAt ? clinicHHMM(session.expectedInAt) : null;
  const expectedOut = session?.expectedOutAt ? clinicHHMM(session.expectedOutAt) : null;
  let headline = '', mood = null, sub = null;
  const facts = [];

  if (action === 'checked_in') {
    headline = `Checked in, ${hhmm}`;
    const state = punct?.state || 'none';
    if (state === 'on_time') {
      mood = `👍 Right on time. Have a good day, ${greet}.`;
      if (expectedIn) facts.push(['Reporting time today', expectedIn]);
    } else if (state === 'early') {
      mood = `🎉✨ You're ${punct.minutes} minutes early!! ✨🎉`;
      if ((month.streakNoRed || 0) >= 2) sub = `${month.streakNoRed} days in a row without a red star — thank you, ${name}.`;
      if (expectedIn) facts.push(['Reporting time today', expectedIn]);
    } else if (state === 'late') {
      mood = `😔 You're ${punct.minutes} minutes late.`;
      sub = 'Tomorrow will be better! 🌅';
      if (expectedIn) facts.push(['Required reporting time today', expectedIn]);
      facts.push(['Check-in time', hhmm]);
      facts.push(['Late check-ins this month', `${month.lateCount || 0} (${monthName})`]);
    } else if (expectedIn) {
      facts.push(['Reporting time today', expectedIn]);
    }
    if (!positiveFeedback && (state === 'on_time' || state === 'early')) { mood = null; sub = null; }
    if (!positiveFeedback && state === 'late') sub = null;
  } else if (action === 'offer_checkout') {
    const since = session?.checkInAt ? clinicHHMM(session.checkInAt) : null;
    const worked = session?.checkInAt ? hoursAndMinutes((now - new Date(session.checkInAt)) / 60000) : null;
    if (punct?.state === 'early') {
      headline = 'Check out early?';
      if (expectedOut) facts.push(['Your day ends at', expectedOut]);
      facts.push(['It\'s now', `${hhmm} · ${punct.minutes} min early`]);
      facts.push(['Early check-outs this month', `${month.earlyOutCount || 0} (${monthName})`]);
    } else {
      headline = 'Check out?';
      if (since) sub = `You've been in since ${since} — ${worked}.`;
    }
  } else if (action === 'checked_out') {
    headline = `Checked out, ${hhmm}`;
    const state = punct?.state || 'none';
    if (state === 'on_time') mood = '👍 See you tomorrow.';
    else if (state === 'late') mood = `🌟 ${punct.minutes} minutes past your hours — thank you, ${name}.`;
    else if (state === 'early') { mood = `😟 Checked out ${punct.minutes} minutes early.`; sub = 'See you tomorrow — on time! 🌅'; }
    if (expectedOut) facts.push(['Your day ends at', expectedOut]);
    if (session?.checkInAt) facts.push(['Today', `${clinicHHMM(session.checkInAt)} – ${hhmm} · ${hoursAndMinutes((now - new Date(session.checkInAt)) / 60000)}`]);
    if (!positiveFeedback && (state === 'on_time' || state === 'late')) mood = null;
    if (!positiveFeedback && state === 'early') sub = null;
  } else if (action === 'duplicate') {
    headline = 'Already recorded';
    const side = duplicateSide || 'in';
    const when = side === 'out' ? session?.checkOutAt : session?.checkInAt;
    sub = `You checked ${side} a minute ago at ${when ? clinicHHMM(when) : hhmm}.`;
  } else if (action === 'refused') {
    headline = 'This tap can\'t be verified';
    sub = 'Please tap the tag at the entrance again. If it keeps happening, tell reception.';
  } else if (action === 'not_enabled') {
    headline = 'Check-in is not enabled for your account';
    sub = 'See HR if you think this is a mistake.';
  }

  return { headline, mood, sub, facts };
};

module.exports = { buildTapMessages, titleFor, greetName, hoursAndMinutes };
