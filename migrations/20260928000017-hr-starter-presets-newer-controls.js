'use strict';

// HR fixes #19 (5 Oct 2026) — the four starter presets (…010) predate the
// controls added in HR Tier 3 Phases 1–5. This gives them the newer ones:
//
//   HR manager       + hr.lists, hr.reports, hr.onboarding, hr.roster, hr.appraisals.run
//   HR officer       + leave.approve, hr.reports, hr.onboarding, hr.roster
//   Nurse in charge  + hr.roster, hr.appraisals.run   (both limited to their own department)
//   Line manager     + hr.appraisals.run              (limited to their own department)
//
// Never hr.confidential, hr.appraisals or hr.grant (PRESET_EXCLUDED). A preset
// is a TEMPLATE: nobody's access changes until HR applies it to someone.
//
// up:   changes a starter preset ONLY while it is untouched — made by …010
//       (createdById NULL), never edited in Settings (updatedById NULL), active
//       — and its grants and withdrawals still exactly equal what …010
//       shipped. A preset HR has edited in any way is left alone. Its description is refreshed
//       only if that too is still …010's. What was added to each row is
//       recorded in a Settings row (MARKER).
// down: for exactly the rows in MARKER, and only while each is still
//       unedited (updatedById NULL) and holds exactly what up left, removes
//       the added controls and limits and puts the description back; then
//       removes the marker.
//
// Guarded with showAllTables / describeTable; table names compared
// case-insensitively. The lists are literal (stored form) so a later
// vocabulary change cannot alter what this migration wrote.

const { PRESETS: SHIPPED } = require('./20260928000010-hr-starter-permission-presets');

const TAG = '[20260928000017]';
const MARKER = 'migration.20260928000017.presetControls';
const OWN = { kind: 'own' };

const ADDITIONS = {
  'HR manager': {
    permissions: ['hr.lists', 'hr.reports', 'hr.onboarding', 'hr.roster', 'hr.appraisals.run'],
    scopes: {},
    description: 'Runs the HR Suite: staff files, onboarding and onboarding checklists, employment status, '
      + 'attendance, leave (including sick-leave details and the policy), CPD, HR settings, departments '
      + 'and positions, HR reports, the shift roster and running appraisals. '
      + 'Does not include confidential documents, reading every appraisal or granting HR permissions — tick those by hand.',
  },
  'HR officer': {
    permissions: ['leave.approve', 'hr.reports', 'hr.onboarding', 'hr.roster'],
    scopes: {},
    description: 'Day-to-day HR: staff files and documents, attendance, recording and approving leave, '
      + 'required approvers, the leave register, profile requests, CPD, HR reports, onboarding checklists '
      + 'and the shift roster. No sick-leave details, employment status, leave policy or HR settings.',
  },
  'Nurse in charge': {
    permissions: ['hr.roster', 'hr.appraisals.run'],
    scopes: { 'hr.roster': OWN, 'hr.appraisals.run': OWN },
    description: 'Leads the nurses: opens their staff files, sees and corrects their attendance, '
      + 'can be chosen to approve their leave and sees who is away, gets their expiry alerts, '
      + 'draws up their shift roster and runs their appraisals. Limited to their own department.',
  },
  'Line manager': {
    permissions: ['hr.appraisals.run'],
    scopes: { 'hr.appraisals.run': OWN },
    description: 'Supervises a team: opens their staff files, sees their attendance, can be chosen '
      + 'to approve their leave, sees who is away and runs their appraisals. Limited to their own department.',
  },
};

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
const list = (v) => { const p = parsed(v); return Array.isArray(p) ? p : []; };
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const canonical = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));

/**
 * Pure: what up writes to one preset row, or null to leave it alone.
 * @param row  { name, permissions, deniedPermissions, scopes, description, updatedById }
 * @returns { permissions, scopes, description, descriptionChanged } | null
 */
const planUp = (row) => {
  const shipped = SHIPPED.find((p) => p.name === row.name);
  const add = ADDITIONS[row.name];
  if (!shipped || !add) return null;
  if (row.updatedById !== null && row.updatedById !== undefined) return null;   // edited in Settings
  if (!sameSet(list(row.permissions), shipped.permissions)) return null;
  if (!sameSet(list(row.deniedPermissions), shipped.deniedPermissions)) return null;
  const descriptionChanged = row.description === shipped.description;
  return {
    permissions: [...shipped.permissions, ...add.permissions.filter((p) => !shipped.permissions.includes(p))],
    scopes: Object.keys(add.scopes).length ? { ...(parsed(row.scopes) || {}), ...add.scopes } : parsed(row.scopes),
    description: descriptionChanged ? add.description : row.description,
    descriptionChanged,
  };
};

/**
 * Pure: what down writes back to one row up changed, or null when the row is
 * no longer exactly what up left (HR has edited it since — leave it alone).
 * @param row   the current row
 * @param done  the marker entry { scopesBefore, descriptionChanged }
 */
const planDown = (row, done) => {
  const shipped = SHIPPED.find((p) => p.name === row.name);
  const add = ADDITIONS[row.name];
  if (!shipped || !add || !done) return null;
  if (row.updatedById !== null && row.updatedById !== undefined) return null;   // HR edited it since
  const upPerms = [...shipped.permissions, ...add.permissions];
  if (!sameSet(list(row.permissions), upPerms)) return null;
  if (!sameSet(list(row.deniedPermissions), shipped.deniedPermissions)) return null;
  const upScopes = Object.keys(add.scopes).length ? { ...(done.scopesBefore || {}), ...add.scopes } : done.scopesBefore;
  if (canonical(parsed(row.scopes)) !== canonical(upScopes ?? null)) return null;
  return {
    permissions: shipped.permissions,
    scopes: done.scopesBefore ?? null,
    description: done.descriptionChanged && row.description === add.description ? shipped.description : row.description,
  };
};

const readMarker = async (qi, settings) => {
  const [rows] = await qi.sequelize.query(`SELECT value FROM \`${settings}\` WHERE \`key\` = ?`, { replacements: [MARKER] });
  return rows.length ? parsed(rows[0].value) : null;
};

const write = (qi, table, id, v) => qi.sequelize.query(
  `UPDATE \`${table}\` SET permissions = ?, scopes = ?, description = ?, updatedAt = ? WHERE id = ?`,
  { replacements: [JSON.stringify(v.permissions), v.scopes == null ? null : JSON.stringify(v.scopes), v.description, new Date(), id] },
);

module.exports = {
  MARKER,
  ADDITIONS,
  _planUp: planUp,
  _planDown: planDown,

  async up(queryInterface) {
    const qi = queryInterface;
    const presets = await findTable(qi, 'PermissionPresets');
    if (!presets) { console.log(`${TAG} no PermissionPresets table — nothing to do`); return; }
    const cols = await qi.describeTable(presets);
    if (!cols.scopes) throw new Error(`${TAG} PermissionPresets.scopes missing — run 20260928000011 first`);
    const settings = await findTable(qi, 'Settings');
    if (!settings) throw new Error(`${TAG} Settings table missing — run the earlier migrations first`);
    if (await readMarker(qi, settings)) { console.log(`${TAG} already applied — nothing to do`); return; }

    const [rows] = await qi.sequelize.query(
      `SELECT id, name, permissions, deniedPermissions, scopes, description, updatedById FROM \`${presets}\`
        WHERE createdById IS NULL AND updatedById IS NULL AND status = 'active' AND name IN (:names)`,
      { replacements: { names: Object.keys(ADDITIONS) } },
    );
    const done = {};
    for (const r of rows) {
      const v = planUp(r);
      if (!v) { console.log(`${TAG} "${r.name}": left alone (edited by the clinic)`); continue; }
      await write(qi, presets, r.id, v);
      done[r.id] = { name: r.name, scopesBefore: parsed(r.scopes), descriptionChanged: v.descriptionChanged };
      console.log(`${TAG} "${r.name}": + ${ADDITIONS[r.name].permissions.join(', ')}`);
    }
    if (Object.keys(done).length) {
      const now = new Date();
      await qi.bulkInsert(settings, [{ key: MARKER, value: JSON.stringify(done), createdAt: now, updatedAt: now }]);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const presets = await findTable(qi, 'PermissionPresets');
    const settings = await findTable(qi, 'Settings');
    if (!presets || !settings) return;
    const done = await readMarker(qi, settings);
    if (!done || !Object.keys(done).length) { console.log(`${TAG} down: nothing this migration changed`); return; }
    const [rows] = await qi.sequelize.query(
      `SELECT id, name, permissions, deniedPermissions, scopes, description, updatedById FROM \`${presets}\` WHERE id IN (:ids)`,
      { replacements: { ids: Object.keys(done).map(Number) } },
    );
    for (const r of rows) {
      const v = planDown(r, done[r.id]);
      if (!v) { console.log(`${TAG} down: "${r.name}" edited since — left alone`); continue; }
      await write(qi, presets, r.id, v);
      console.log(`${TAG} down: "${r.name}" restored`);
    }
    await qi.bulkDelete(settings, { key: MARKER });
  },
};
