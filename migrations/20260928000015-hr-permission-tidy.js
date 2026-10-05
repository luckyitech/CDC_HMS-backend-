'use strict';

// HR Tier 3 follow-up (Emu, 3 Oct 2026: "fix these") — decision P-9 b, the
// one-off permissions tidy. Before this, four older broad grants carried their
// HR parts at read time:
//
//   users.view      carried  staff.view                         (BUNDLES)
//   users.write     carried  staff.edit, staff.onboard,
//                            staff.status, staff.documents       (BUNDLES)
//   hr.write        meant    hr.view, hr.attendance.amend,
//                            hr.workhours, hr.tags               (LEGACY_PERMISSIONS)
//   hr.credentials  meant    cpd.verify, hr.expiry.alerts        (LEGACY_PERMISSIONS)
//
// This migration writes those parts as explicit grants (and explicit
// withdrawals, where the broad one was withdrawn) on every staff account and
// every permission preset, so the HR controls show as ticked in their own
// right. users.view / users.write STAY (they still gate the Manage Users
// screen); hr.write / hr.credentials are REMOVED from storage (their meaning is
// now spelled out). From this release users.view / users.write no longer carry
// staff-file controls (constants/permissions BUNDLES) — so NOBODY'S ACCESS
// CHANGES: everyone who had a part through the broad grant now holds it
// directly.
//
// A part already withdrawn from that person is not granted (a withdrawal
// always won). Department scopes are untouched: the old grants were never
// scopable, and an explicit grant with no scope row means All staff — the same
// reach as before.
//
// Every row it changes is backed up first in PermissionTidyBackups, so `down`
// restores exactly what was there and drops the backup table. `down` REFUSES
// if anyone's permissions were changed after the tidy (restoring would undo
// that change) — restore the database backup instead.
//
// The rules are FROZEN here (tests/hrPermissionTidy.test.js exercises them).

const TAG = '[20260928000015]';

// What a GRANT carried (users.write implied users.view, which carried staff.view)…
const CARRY = {
  'users.view': ['staff.view'],
  'users.write': ['staff.edit', 'staff.onboard', 'staff.status', 'staff.documents', 'staff.view'],
};
// …and what a WITHDRAWAL withdrew (the bundle's own parts only).
const CARRY_DENIED = {
  'users.view': ['staff.view'],
  'users.write': ['staff.edit', 'staff.onboard', 'staff.status', 'staff.documents'],
};
const REPLACE = {
  'hr.write': ['hr.view', 'hr.attendance.amend', 'hr.workhours', 'hr.tags'],
  'hr.credentials': ['cpd.verify', 'hr.expiry.alerts'],
};

const asList = (v) => {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};
const uniq = (a) => [...new Set(a)];

/** { permissions, deniedPermissions } → the tidied pair (pure, frozen). */
const tidy = ({ permissions, deniedPermissions }) => {
  const granted = asList(permissions);
  const denied = asList(deniedPermissions);
  const outDenied = [];
  for (const p of denied) {
    if (REPLACE[p]) outDenied.push(...REPLACE[p]);
    else { outDenied.push(p); if (CARRY_DENIED[p]) outDenied.push(...CARRY_DENIED[p]); }
  }
  const deniedSet = new Set(outDenied);
  const outGranted = [];
  for (const p of granted) {
    if (REPLACE[p]) outGranted.push(...REPLACE[p].filter((x) => !deniedSet.has(x)));
    else { outGranted.push(p); if (CARRY[p]) outGranted.push(...CARRY[p].filter((x) => !deniedSet.has(x))); }
  }
  return { permissions: uniq(outGranted), deniedPermissions: uniq(outDenied) };
};

const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  _tidy: tidy,
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const q = (sql, replacements) => qi.sequelize.query(sql, { replacements });
    if (!(await findTable(qi, 'PermissionTidyBackups'))) {
      await qi.createTable('PermissionTidyBackups', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        kind: { type: Sequelize.ENUM('user', 'preset'), allowNull: false },
        rowId: { type: Sequelize.INTEGER, allowNull: false },
        permissions: { type: Sequelize.TEXT('long'), allowNull: true },
        deniedPermissions: { type: Sequelize.TEXT('long'), allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
    } else {
      const [done] = await q('SELECT COUNT(*) AS n FROM PermissionTidyBackups');
      if (Number(done[0].n ?? done[0].N) > 0) { console.log(`${TAG} already applied — nothing to do`); return; }
    }
    const backups = await findTable(qi, 'PermissionTidyBackups');
    const now = new Date();
    let users = 0; let presets = 0;

    const usersTable = await findTable(qi, 'Users');
    const [rows] = await q(`SELECT id, permissions, deniedPermissions FROM \`${usersTable}\` WHERE role <> 'patient'`);
    for (const r of rows) {
      const before = { permissions: asList(r.permissions), deniedPermissions: asList(r.deniedPermissions) };
      const after = tidy(before);
      if (same(before.permissions, after.permissions) && same(before.deniedPermissions, after.deniedPermissions)) continue;
      await q(`INSERT INTO \`${backups}\` (kind, rowId, permissions, deniedPermissions, createdAt) VALUES ('user', ?, ?, ?, ?)`,
        [r.id, JSON.stringify(before.permissions), JSON.stringify(before.deniedPermissions), now]);
      await q(`UPDATE \`${usersTable}\` SET permissions = ?, deniedPermissions = ? WHERE id = ?`,
        [JSON.stringify(after.permissions), JSON.stringify(after.deniedPermissions), r.id]);
      users += 1;
    }

    const presetTable = await findTable(qi, 'PermissionPresets');
    if (presetTable) {
      const [prows] = await q(`SELECT id, permissions, deniedPermissions FROM \`${presetTable}\``);
      for (const r of prows) {
        const before = { permissions: asList(r.permissions), deniedPermissions: asList(r.deniedPermissions) };
        const after = tidy(before);
        if (same(before.permissions, after.permissions) && same(before.deniedPermissions, after.deniedPermissions)) continue;
        await q(`INSERT INTO \`${backups}\` (kind, rowId, permissions, deniedPermissions, createdAt) VALUES ('preset', ?, ?, ?, ?)`,
          [r.id, JSON.stringify(before.permissions), JSON.stringify(before.deniedPermissions), now]);
        await q(`UPDATE \`${presetTable}\` SET permissions = ?, deniedPermissions = ? WHERE id = ?`,
          [JSON.stringify(after.permissions), JSON.stringify(after.deniedPermissions), r.id]);
        presets += 1;
      }
    }
    console.log(`${TAG} permissions tidy: ${users} staff account(s) and ${presets} preset(s) converted (backed up in PermissionTidyBackups)`);
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const q = (sql, replacements) => qi.sequelize.query(sql, { replacements });
    const backups = await findTable(qi, 'PermissionTidyBackups');
    if (!backups) return;
    const usersTable = await findTable(qi, 'Users');
    const presetTable = await findTable(qi, 'PermissionPresets');
    const [rows] = await q(`SELECT kind, rowId, permissions, deniedPermissions FROM \`${backups}\``);
    for (const r of rows) {
      const table = r.kind === 'user' ? usersTable : presetTable;
      if (!table) continue;
      const [cur] = await q(`SELECT permissions, deniedPermissions FROM \`${table}\` WHERE id = ?`, [r.rowId]);
      if (!cur.length) continue;
      const expected = tidy({ permissions: r.permissions, deniedPermissions: r.deniedPermissions });
      const now = { permissions: asList(cur[0].permissions), deniedPermissions: asList(cur[0].deniedPermissions) };
      if (!same(expected.permissions, now.permissions) || !same(expected.deniedPermissions, now.deniedPermissions)) {
        throw new Error(`${TAG} down refused: the ${r.kind} #${r.rowId}'s permissions changed after the tidy. Restore the database backup instead.`);
      }
    }
    for (const r of rows) {
      const table = r.kind === 'user' ? usersTable : presetTable;
      if (!table) continue;
      await q(`UPDATE \`${table}\` SET permissions = ?, deniedPermissions = ? WHERE id = ?`, [r.permissions, r.deniedPermissions, r.rowId]);
    }
    console.log(`${TAG} restored ${rows.length} row(s) from PermissionTidyBackups`);
    await qi.dropTable(backups);
  },
};
