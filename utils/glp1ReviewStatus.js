/**
 * Is a planned doctor review outstanding on a GLP-1 course right now?
 *
 * A course carries `reviewWeeks` — the weeks the doctor wants the patient SEEN,
 * not merely injected. Those are the dose-step boundaries (where the amount is
 * about to go up) plus the follow-up points on the open-ended maintenance step,
 * which exist so a patient at a stable dose still comes up for review.
 *
 * Two screens need the answer and must never disagree about it:
 *   - the nurse's triage card, which offers to send a patient home without a
 *     doctor and has to say when that offer is the wrong one;
 *   - the doctor's tracker, which decides which visit to open next.
 * Deriving it here rather than in either UI is what keeps them in step, and
 * gives a later consumer (a report, a reminder job) the same rule for free.
 *
 * A review stays outstanding until it is recorded or the doctor drops the week
 * from the schedule. It does NOT lapse once the patient is past it — a review
 * that was missed is precisely the thing that should keep asking to be dealt
 * with, so the warning follows the patient into later weeks rather than
 * disappearing the moment it would matter most.
 */

/** Nothing outstanding. A fresh object each time: callers may serialise or extend it. */
const none = () => ({
  due:              false,
  week:             null,
  weeksOverdue:     0,
  outstandingWeeks: [],
});

/**
 * A week number, or null if it is not one. Rejects NaN, negatives and fractions.
 *
 * The type guard is doing real work, not being defensive for its own sake:
 * Number(null), Number('') and Number([]) are all 0, so a null left in a stored
 * reviewWeeks array would otherwise read as a genuine review due at week 0 and
 * warn on every patient carrying one.
 */
const toWeek = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * @param {object} therapy  a FORMATTED therapy (formatTherapy output) — needs
 *                          currentWeek, reviewWeeks and doseSchedule
 * @param {Array}  reviews  the course's recorded reviews, each with weekNumber
 * @returns {{ due: boolean, week: number|null, weeksOverdue: number, outstandingWeeks: number[] }}
 *          week is the EARLIEST outstanding review; weeksOverdue is 0 when it
 *          falls in the current week and counts up once it has been passed.
 */
const buildReviewStatus = (therapy, reviews = []) => {
  if (!therapy) return none();

  // currentWeek is derived by formatTherapy and is null for anything that is
  // not an Active course, so a stopped, paused or future-dated course is never
  // "due" — there is no ongoing treatment to review.
  const currentWeek = toWeek(therapy.currentWeek);
  if (currentWeek === null) return none();

  /**
   * A transferred-in patient's ladder starts at the week they joined us — say
   * week 16 — and startDate is the day we picked them up. Planned weeks before
   * that belong to a clinic we hold no records from, so flagging week 4 as
   * outstanding would ask the nurse to chase a visit that was never ours.
   */
  const schedule = Array.isArray(therapy.doseSchedule) ? therapy.doseSchedule : [];
  const courseStartWeek = toWeek(schedule[0]?.fromWeek) ?? 0;

  const recorded = new Set(
    (Array.isArray(reviews) ? reviews : [])
      .map((r) => toWeek(r?.weekNumber))
      .filter((w) => w !== null)
  );

  // Planned, ours to hold, and not yet recorded.
  const pending = (Array.isArray(therapy.reviewWeeks) ? therapy.reviewWeeks : [])
    .map(toWeek)
    .filter((w) => w !== null && w >= courseStartWeek && !recorded.has(w))
    .sort((a, b) => a - b);

  // Only a week the patient has actually reached is outstanding; the rest are
  // simply still ahead of them.
  const outstandingWeeks = pending.filter((w) => w <= currentWeek);
  const week = outstandingWeeks.length ? outstandingWeeks[0] : null;

  return {
    due:          week !== null,
    week,
    weeksOverdue: week === null ? 0 : currentWeek - week,
    outstandingWeeks,
  };
};

module.exports = { buildReviewStatus };
