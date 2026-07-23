/**
 * The weekly side-effect summary that sits above the entry grid in the tracker.
 *
 * Rows are symptoms that have actually been reported — a symptom graded 'none'
 * at every visit never earns a row, which is what keeps the grid readable after
 * a year of reviews. Columns are the weeks that have a review.
 *
 * The clinically interesting part is `alerts`: a symptom that got worse across a
 * dose step. That is the pattern a doctor is scanning the grid for, so the
 * server names it rather than leaving it to be spotted.
 */

const { doseStepForReview } = require('./glp1Schedule');

const SEVERITY_RANK = { none: 0, mild: 1, moderate: 2, severe: 3 };

const rank = (severity) => SEVERITY_RANK[severity] ?? 0;

// Reads naturally in a sentence: "nausea worsened from mild to moderate".
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Builds the summary for one course.
 *
 * @param {object} therapy  needs doseSchedule
 * @param {Array}  reviews  review rows, each with a sideEffects array
 *                          [{ weekNumber, sideEffects: [{ symptomId, symptom, severity, note }] }]
 * @returns {{ weeks, rows, alerts, headline, reviewCount }}
 */
const buildWeeklySummary = (therapy, reviews = []) => {
  const schedule = therapy?.doseSchedule || [];

  // Oldest first — every comparison below is against the previous review.
  const ordered = [...reviews].sort((a, b) => a.weekNumber - b.weekNumber);
  const weeks = ordered.map((r) => r.weekNumber);

  // --- Gather every symptom ever graded, keyed by catalogue id ---
  const symptoms = new Map();

  ordered.forEach((review) => {
    (review.sideEffects || []).forEach((se) => {
      const key = se.symptomId ?? se.symptom;

      if (!symptoms.has(key)) {
        symptoms.set(key, {
          symptomId: se.symptomId ?? null,
          symptom:   se.symptom,
          cells:     {},
          everReported: false,
        });
      }

      const row = symptoms.get(key);
      row.cells[review.weekNumber] = { severity: se.severity, note: se.note || null };
      if (rank(se.severity) > 0) row.everReported = true;
    });
  });

  // --- Only symptoms actually reported get a row ---
  const rows = [...symptoms.values()]
    .filter((row) => row.everReported)
    .map((row) => {
      const graded = weeks
        .filter((w) => row.cells[w])
        .map((w) => ({ week: w, severity: row.cells[w].severity }));

      const worst = graded.reduce(
        (acc, g) => (rank(g.severity) > rank(acc.severity) ? g : acc),
        graded[0] || { week: null, severity: 'none' }
      );
      const latest = graded[graded.length - 1] || { week: null, severity: 'none' };
      const first  = graded.find((g) => rank(g.severity) > 0) || null;

      return {
        symptomId:     row.symptomId,
        symptom:       row.symptom,
        cells:         row.cells,
        worstSeverity: worst.severity,
        worstWeek:     worst.week,
        latestSeverity: latest.severity,
        latestWeek:    latest.week,
        firstReportedWeek: first ? first.week : null,
        // Did it settle? Reported at some point, 'none' at the latest review.
        settled: rank(latest.severity) === 0,
      };
    })
    .sort((a, b) => rank(b.worstSeverity) - rank(a.worstSeverity) || a.symptom.localeCompare(b.symptom));

  // --- Worsening across a dose step ---
  //
  // The dose a review reports on is the one taken during the interval leading up
  // to it, not the one started at the visit — see doseStepForReview. A recorded
  // doseAtReview beats the ladder, because it is what the patient actually took.
  const doseAtWeek = new Map();
  ordered.forEach((review) => {
    const laddered = doseStepForReview(schedule, review.weekNumber);
    const recorded = review.doseAtReview !== null && review.doseAtReview !== undefined
      ? Number(review.doseAtReview)
      : null;
    doseAtWeek.set(review.weekNumber, Number.isFinite(recorded) ? recorded : (laddered ? laddered.dose : null));
  });

  const alerts = [];

  rows.forEach((row) => {
    const graded = weeks.filter((w) => row.cells[w]).map((w) => ({ week: w, ...row.cells[w] }));

    for (let i = 1; i < graded.length; i += 1) {
      const prev = graded[i - 1];
      const curr = graded[i];
      if (rank(curr.severity) <= rank(prev.severity)) continue;

      const prevDose = doseAtWeek.get(prev.week);
      const currDose = doseAtWeek.get(curr.week);
      const doseChanged = prevDose !== null && currDose !== null && prevDose !== currDose;

      alerts.push({
        symptom:          row.symptom,
        symptomId:        row.symptomId,
        fromWeek:         prev.week,
        week:             curr.week,
        previousSeverity: prev.severity,
        severity:         curr.severity,
        doseChanged:      Boolean(doseChanged),
        fromDose:         prevDose,
        toDose:           currDose,
        message: doseChanged
          ? `${row.symptom} worsened from ${prev.severity} to ${curr.severity} at week ${curr.week}, ` +
            `after the dose step from ${prevDose} to ${currDose}`
          : `${row.symptom} worsened from ${prev.severity} to ${curr.severity} at week ${curr.week}, ` +
            'on an unchanged dose',
      });
    }
  });

  // --- One-line headline ---
  let headline;

  if (!ordered.length) {
    headline = 'No monitoring reviews recorded yet.';
  } else if (!rows.length) {
    headline = `No side effects reported across ${plural(ordered.length, 'review')}.`;
  } else {
    const latestWeek = weeks[weeks.length - 1];
    const current = rows.filter((r) => rank(r.latestSeverity) >= 2);
    const settled = rows.filter((r) => r.settled);

    const parts = [];

    if (current.length) {
      parts.push(
        `At week ${latestWeek}: ` +
        current.map((r) => `${r.symptom.toLowerCase()} ${r.latestSeverity}`).join(', ')
      );
    } else {
      parts.push(`Nothing moderate or worse at week ${latestWeek}`);
    }

    if (settled.length) parts.push(`${plural(settled.length, 'symptom')} settled`);

    const doseAlerts = alerts.filter((a) => a.doseChanged);
    if (doseAlerts.length) {
      parts.push(`${plural(doseAlerts.length, 'symptom')} worsened after a dose step`);
    }

    headline = `${parts.join('. ')}.`;
  }

  return {
    weeks,
    rows,
    alerts,
    headline,
    reviewCount: ordered.length,
  };
};

module.exports = {
  SEVERITY_RANK,
  rank,
  buildWeeklySummary,
};
