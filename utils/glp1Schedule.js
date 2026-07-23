/**
 * Dose ladder helpers for the GLP-1 monitoring tool.
 *
 * A schedule is an array of steps:
 *   [{ fromWeek: 0, toWeek: 4, dose: 2.5, note: 'Initiation' },
 *    { fromWeek: 4, toWeek: null, dose: 5 }]
 *
 * fromWeek is inclusive, toWeek is exclusive, and toWeek null means "continue
 * indefinitely". Week 0 is the week therapy started.
 *
 * The formulary holds a clinic default; each patient gets an editable copy on
 * their own therapy row, so editing one patient's ladder never rewrites the
 * clinic default or anyone else's course.
 */

/**
 * Builds a titration ladder from a list of strengths and an interval.
 * Used when a medication is added to the formulary without an explicit ladder.
 *
 * @param {number[]} strengths      e.g. [2.5, 5, 7.5, 10]
 * @param {number}   titrationWeeks weeks spent at each step
 * @returns {Array} steps, last one open-ended
 */
const buildDefaultSchedule = (strengths, titrationWeeks = 4) => {
  const doses = (Array.isArray(strengths) ? strengths : [])
    .map(Number)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);

  const weeks = Number(titrationWeeks) > 0 ? Math.floor(Number(titrationWeeks)) : 4;

  return doses.map((dose, i) => ({
    fromWeek: i * weeks,
    toWeek:   i === doses.length - 1 ? null : (i + 1) * weeks,
    dose,
    note:     i === 0 ? 'Initiation' : (i === doses.length - 1 ? 'Maximum dose' : null),
  }));
};

/**
 * Validates a schedule submitted by the client.
 * Returns { ok, message, schedule } with the schedule normalised and sorted.
 *
 * Rejects overlaps and gaps rather than silently accepting them — a ladder with
 * a hole in it would show a patient as being on no dose for a stretch of weeks.
 *
 * A patient who does not fit the standard ladder — transferred in mid-therapy,
 * or titrated on a different interval — is handled by a custom regimen, whose
 * ladder is built to fit them and is therefore contiguous by construction.
 * Relaxing this check is not the answer; building the right ladder is.
 */
const validateSchedule = (schedule) => {
  const bad = (message) => ({ ok: false, message, schedule: null });

  if (!Array.isArray(schedule)) return bad('Dose schedule must be an array of steps');
  if (!schedule.length)         return bad('Dose schedule must have at least one step');

  const steps = [];

  for (let i = 0; i < schedule.length; i += 1) {
    const s = schedule[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return bad(`Step ${i + 1} is not an object`);
    }

    const fromWeek = Number(s.fromWeek);
    if (!Number.isInteger(fromWeek) || fromWeek < 0) {
      return bad(`Step ${i + 1}: fromWeek must be a whole number of weeks, 0 or greater`);
    }

    const toWeek = s.toWeek === null || s.toWeek === undefined ? null : Number(s.toWeek);
    if (toWeek !== null && (!Number.isInteger(toWeek) || toWeek <= fromWeek)) {
      return bad(`Step ${i + 1}: toWeek must be a whole number greater than fromWeek, or null for open-ended`);
    }

    const dose = Number(s.dose);
    if (!Number.isFinite(dose) || dose <= 0) {
      return bad(`Step ${i + 1}: dose must be a number greater than zero`);
    }

    steps.push({
      fromWeek,
      toWeek,
      dose,
      note: typeof s.note === 'string' && s.note.trim() ? s.note.trim() : null,
    });
  }

  steps.sort((a, b) => a.fromWeek - b.fromWeek);

  // Exactly one open-ended step, and it must be the last.
  const openEnded = steps.filter((s) => s.toWeek === null);
  if (openEnded.length > 1) return bad('Only the final step may be open-ended (toWeek null)');
  if (openEnded.length === 1 && steps[steps.length - 1].toWeek !== null) {
    return bad('An open-ended step (toWeek null) must be the last step');
  }

  // No gaps, no overlaps.
  for (let i = 0; i < steps.length - 1; i += 1) {
    if (steps[i].toWeek === null) continue;
    if (steps[i].toWeek > steps[i + 1].fromWeek) {
      return bad(`Steps ${i + 1} and ${i + 2} overlap — week ${steps[i + 1].fromWeek} appears twice`);
    }
    if (steps[i].toWeek < steps[i + 1].fromWeek) {
      return bad(`Gap between steps ${i + 1} and ${i + 2} — no dose covers week ${steps[i].toWeek}`);
    }
  }

  return { ok: true, message: null, schedule: steps };
};

/**
 * Builds a ladder from a list of { dose, weeks } rungs.
 *
 * This is what a custom regimen is: the doctor states each dose and how long
 * the patient stays on it. Contiguity is guaranteed because each rung starts
 * where the previous one ended, so a custom ladder can never produce the gap
 * error above.
 *
 * @param {Array}  rungs      [{ dose, weeks }] — weeks omitted on the last rung
 *                            makes it open-ended
 * @param {number} startWeek  week the course begins; non-zero for a patient
 *                            continuing therapy started elsewhere
 */
const buildCustomSchedule = (rungs, startWeek = 0) => {
  let cursor = Number.isInteger(Number(startWeek)) && Number(startWeek) >= 0
    ? Number(startWeek)
    : 0;

  const list = Array.isArray(rungs) ? rungs : [];

  return list.map((rung, i) => {
    const isLast = i === list.length - 1;
    const weeks  = Number(rung?.weeks);
    const hasSpan = Number.isInteger(weeks) && weeks > 0;

    const fromWeek = cursor;
    // The final rung runs on unless the doctor gave it an explicit length
    const toWeek = isLast && !hasSpan ? null : fromWeek + (hasSpan ? weeks : 4);
    if (toWeek !== null) cursor = toWeek;

    return {
      fromWeek,
      toWeek,
      dose: Number(rung?.dose),
      note: typeof rung?.note === 'string' && rung.note.trim() ? rung.note.trim() : null,
    };
  });
};

/**
 * Monitoring weeks implied by a ladder: one review at the start of the course
 * and one at each dose change, since a dose change is precisely when the
 * patient needs reviewing. Used for custom regimens, where the standard
 * 4/8/12/24/36/52 pattern no longer lines up with anything real.
 *
 * @param {Array}  schedule    validated steps
 * @param {number} followUpWks how long to keep reviewing past the last change
 */
const reviewWeeksForSchedule = (schedule, followUpWks = 12) => {
  if (!Array.isArray(schedule) || !schedule.length) return [];

  // Every step boundary is a dose change worth reviewing
  const weeks = new Set(schedule.map((s) => s.fromWeek));

  // The open-ended maintenance step needs review points of its own, otherwise
  // a patient at a stable dose would never come up for review again
  const last = schedule[schedule.length - 1];
  if (last.toWeek === null) {
    weeks.add(last.fromWeek + followUpWks);
    weeks.add(last.fromWeek + followUpWks * 2);
  }

  return [...weeks].sort((a, b) => a - b);
};

/**
 * Whole weeks elapsed since therapy started. Week 0 is the starting week.
 * Returns null when there is no usable start date.
 */
const weeksSince = (startDate, asOf = new Date()) => {
  if (!startDate) return null;

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return null;

  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const elapsed = Math.floor((asOf.getTime() - start.getTime()) / MS_PER_WEEK);

  return elapsed < 0 ? null : elapsed;
};

/**
 * The step covering a given week, or null if the ladder does not reach it.
 */
const stepForWeek = (schedule, week) => {
  if (!Array.isArray(schedule) || week === null || week === undefined) return null;

  return schedule.find((s) =>
    week >= s.fromWeek && (s.toWeek === null || week < s.toWeek)
  ) || null;
};

/**
 * The dose a review is actually reporting on.
 *
 * A review at week 4 asks how the patient has been since week 0 — during which
 * they were on the week 0-4 dose, not the one they are stepping up to at that
 * visit. stepForWeek(4) returns the NEW dose, which is right for "what should
 * they take from today" and wrong for "what were they on when this nausea
 * happened". Attributing a symptom to a dose the patient had not yet taken is
 * how a titration schedule gets blamed for the wrong step.
 *
 * So: look one week back, floored at week 0.
 */
const doseStepForReview = (schedule, week) => {
  if (week === null || week === undefined) return null;
  return stepForWeek(schedule, week > 0 ? week - 1 : 0);
};

module.exports = {
  buildDefaultSchedule,
  buildCustomSchedule,
  reviewWeeksForSchedule,
  validateSchedule,
  weeksSince,
  stepForWeek,
  doseStepForReview,
};
