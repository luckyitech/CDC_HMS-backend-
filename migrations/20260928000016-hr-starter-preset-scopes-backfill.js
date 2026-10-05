'use strict';

// HR fixes #23 (5 Oct 2026) — backfill the "own department" limits on the
// "Nurse in charge" and "Line manager" starter presets.
//
// Migration …011 sets them only inside the run that ADDS the
// PermissionPresets.scopes column. On a database where the app booted before
// `npm run migrate` (server.js sync() creates a missing table from the model,
// which already has `scopes`), …011 skipped that block and the two presets kept
// scopes = NULL — a nurse in charge given the preset would then see every
// department. Production is NOT affected (its table pre-dated the column, so
// …011 wrote the limits); there this migration changes nothing.
//
// up:   for each of the two presets, sets …011's limits (imported from …011,
//       so they cannot drift) only when the preset is untouched — made by …010
//       (createdById NULL), never edited (updatedById NULL), never applied
//       (appliedCount 0) — and its limits are still empty. The ids it changed
//       are recorded in a Settings row (MARKER).
// down: resets exactly the rows recorded in MARKER back to NULL, and only while
//       they still hold exactly what up wrote and are still untouched; then
//       removes the marker. Without the marker (production: nothing done) it
//       changes nothing.
//
// Guarded with showAllTables / describeTable; table names compared
// case-insensitively (the VDS returns them lowercase).

const { _starterScopes: STARTER_SCOPES } = require('./20260928000011-hr-departments-positions-scopes');

const TAG = '[20260928000016]';
const MARKER = 'migration.20260928000016.backfilled';
const UNTOUCHED = 'createdById IS NULL AND updatedById IS NULL AND appliedCount = 0';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

/** A JSON column may come back parsed (MySQL) or as text (MariaDB). */
const parsed = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** "Empty": no limits stored at all. */
const isEmpty = (v) => {
  const p = parsed(v);
  return p === null || (typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0);
};

// Key order is not preserved by MySQL's JSON type — compare canonically.
const canonical = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const sameJson = (a, b) => canonical(a) === canonical(b);

const readMarker = async (qi, settings) => {
  if (!settings) return null;
  const [rows] = await qi.sequelize.query(`SELECT value FROM \`${settings}\` WHERE \`key\` = ?`, { replacements: [MARKER] });
  return rows.length ? parsed(rows[0].value) : null;
};

module.exports = {
  MARKER,
  _isEmpty: isEmpty,
  _sameJson: sameJson,

  async up(queryInterface) {
    const qi = queryInterface;
    const presets = await findTable(qi, 'PermissionPresets');
    if (!presets) { console.log(`${TAG} no PermissionPresets table — nothing to do`); return; }
    const cols = await qi.describeTable(presets);
    if (!cols.scopes) { console.log(`${TAG} PermissionPresets has no scopes column — nothing to do`); return; }
    const settings = await findTable(qi, 'Settings');
    if (!settings) throw new Error(`${TAG} Settings table missing — run the earlier migrations first`);
    if (await readMarker(qi, settings)) { console.log(`${TAG} already applied — nothing to do`); return; }

    const changed = [];
    for (const [name, scopes] of Object.entries(STARTER_SCOPES)) {
      const [rows] = await qi.sequelize.query(
        `SELECT id, scopes FROM \`${presets}\` WHERE name = ? AND ${UNTOUCHED}`,
        { replacements: [name] },
      );
      const row = rows.find((r) => isEmpty(r.scopes));
      if (!row) { console.log(`${TAG} "${name}": left alone (limits already set, edited, applied or absent)`); continue; }
      await qi.sequelize.query(`UPDATE \`${presets}\` SET scopes = ? WHERE id = ?`, { replacements: [JSON.stringify(scopes), row.id] });
      changed.push(row.id);
      console.log(`${TAG} "${name}": own-department limits set`);
    }
    if (changed.length) {
      const now = new Date();
      await qi.bulkInsert(settings, [{ key: MARKER, value: JSON.stringify(changed), createdAt: now, updatedAt: now }]);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const presets = await findTable(qi, 'PermissionPresets');
    const settings = await findTable(qi, 'Settings');
    const ids = await readMarker(qi, settings);
    if (!presets || !Array.isArray(ids) || !ids.length) { console.log(`${TAG} down: nothing this migration set`); return; }
    const cols = await qi.describeTable(presets);
    if (cols.scopes) {
      const [rows] = await qi.sequelize.query(
        `SELECT id, name, scopes FROM \`${presets}\` WHERE id IN (:ids) AND ${UNTOUCHED}`,
        { replacements: { ids } },
      );
      for (const r of rows) {
        if (!STARTER_SCOPES[r.name] || !sameJson(parsed(r.scopes), STARTER_SCOPES[r.name])) continue;
        await qi.sequelize.query(`UPDATE \`${presets}\` SET scopes = NULL WHERE id = ?`, { replacements: [r.id] });
        console.log(`${TAG} down: "${r.name}" limits cleared`);
      }
    }
    await qi.bulkDelete(settings, { key: MARKER });
  },
};
