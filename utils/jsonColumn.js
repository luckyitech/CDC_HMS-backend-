// =====================================================================
// Defensive JSON-column read.
//
// MariaDB returns JSON columns as strings; MySQL 8 returns parsed objects.
// Anything that reads a Sequelize JSON column and hands it to the client or to
// other code must normalise it to an object first, or the two databases behave
// differently (the diary `detail`, seen 13 Sep). One helper, used everywhere a
// JSON column is read, so the two engines can never diverge.
// =====================================================================

const parseJsonColumn = (d) => {
  if (d === null || d === undefined) return null;
  if (typeof d === 'object') return d;
  try { const o = JSON.parse(d); return o && typeof o === 'object' ? o : null; } catch { return null; }
};

module.exports = { parseJsonColumn };
