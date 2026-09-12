// =====================================================================
// Naive wall-clock time for home-meter readings.
//
// A glucose meter's timestamp has no timezone: it is whatever its own clock
// showed. The HMS keeps it exactly that way — stored, compared and displayed
// as the meter's wall time, never shifted — and records the drift against
// the importing PC beside it instead (GlucoseMeterReadings.hostClockDeltaSec).
//
// Sequelize round-trips DATE columns through UTC (config/database.js leaves
// the default '+00:00'), so a naive wall time is carried in a JS Date whose
// UTC fields ARE the wall-clock fields. Encode with Date.UTC, decode with the
// getUTC* accessors, and the stored DATETIME equals the meter's display no
// matter what timezone the server or the VDS is set to. Nothing outside this
// file should touch a meter timestamp with local-time accessors.
// =====================================================================

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD HH:mm:ss' (or 'YYYY-MM-DDTHH:mm:ss') → JS Date carrying it as UTC.
const naiveToDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se || 0));
  return Number.isNaN(dt.getTime()) ? null : dt;
};

// JS Date (as stored) → 'YYYY-MM-DD HH:mm:ss' wall time.
const dateToNaive = (dt) => {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const naiveDay  = (dt) => dateToNaive(dt)?.slice(0, 10) || null;   // 'YYYY-MM-DD'
const naiveHour = (dt) => (dt instanceof Date ? dt : new Date(dt)).getUTCHours();

// A DATEONLY string → the naive midnight that starts it (for range queries
// against measuredAt).
const naiveDayStart = (day) => naiveToDate(`${day} 00:00:00`);
const naiveDayEnd   = (day) => naiveToDate(`${day} 23:59:59`);

module.exports = { naiveToDate, dateToNaive, naiveDay, naiveHour, naiveDayStart, naiveDayEnd };
