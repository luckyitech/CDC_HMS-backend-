// ============================================================
// NEWS2 scoring — server-side canonical implementation.
// Pure, unit-testable, no dependencies. Computes the aggregate score, the
// per-parameter breakdown, and an escalation band. Uses SpO2 Scale 1
// (a per-patient Scale 2 toggle is a future extension).
//
// IMPORTANT: the caller stores the result FROZEN on the observation row. Never
// recompute stored rows if this logic changes — that would falsify the record.
// ============================================================

const band = (value, ranges, fallback = 0) => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  for (const [min, max, score] of ranges) {
    if (value >= min && value <= max) return score;
  }
  return fallback;
};

// Each range: [min, max, score]
const respRateScore = (v) => band(v, [
  [-Infinity, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, Infinity, 3],
]);

const spo2Score = (v) => band(v, [
  [-Infinity, 91, 3], [92, 93, 2], [94, 95, 1], [96, Infinity, 0],
]);

const systolicScore = (v) => band(v, [
  [-Infinity, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, Infinity, 3],
]);

const heartRateScore = (v) => band(v, [
  [-Infinity, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, Infinity, 3],
]);

const tempScore = (v) => band(v, [
  [-Infinity, 35.0, 3], [35.1, 36.0, 1], [36.1, 38.0, 0], [38.1, 39.0, 1], [39.1, Infinity, 2],
]);

/**
 * @param {object} obs raw observation params
 * @returns {{ total:number, breakdown:object, escalation:'None'|'Low'|'Medium'|'High' }}
 */
const score = (obs = {}) => {
  const breakdown = {
    respRate:      respRateScore(obs.respRate),
    spo2:          spo2Score(obs.spo2),
    oxygen:        obs.onOxygen ? 2 : 0,
    systolicBP:    systolicScore(obs.systolicBP),
    heartRate:     heartRateScore(obs.heartRate),
    consciousness: obs.consciousness && obs.consciousness !== 'A' ? 3 : 0,
    temperature:   tempScore(obs.temperature),
  };

  const parts = Object.values(breakdown).filter((s) => s !== null);
  const total = parts.reduce((a, b) => a + b, 0);
  const anyThree = Object.values(breakdown).some((s) => s === 3);

  // Escalation: NHS NEWS2 clinical response bands.
  let escalation = 'None';
  if (total >= 7) escalation = 'High';
  else if (total >= 5 || anyThree) escalation = 'Medium';
  else if (total >= 1) escalation = 'Low';

  return { total, breakdown, escalation };
};

module.exports = { score };
