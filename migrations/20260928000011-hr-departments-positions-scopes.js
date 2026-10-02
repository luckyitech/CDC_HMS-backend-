'use strict';

// HR Suite Tier 3 Phase 1 (Emu, 2 Oct 2026 — T3-1a, T3-2a, P-1/P-7/P-8).
//
//   Departments              NEW (name UNIQUE, status active|archived, createdById)
//   Positions                NEW (name UNIQUE, cadre doctor|nurse|lab|staff NULL,
//                            status active|archived, createdById)
//   StaffProfiles.departmentId  INT NULL → Departments   the department, from the list
//   StaffProfiles.positionId    INT NULL → Positions     the position, from the list
//   PermissionScopes         NEW (UserId, capability, kind own|department,
//                            departmentId NULL, setById) — a department limit on
//                            one HR control for one person. NO row = "All staff",
//                            which is what every grant meant before this phase,
//                            so nobody's access changes at deploy.
//   PermissionPresets.scopes JSON NULL — "their own department" limits a preset
//                            carries (mockup D). The two starter presets made by
//                            …010 that are meant for a department lead — "Nurse
//                            in charge" and "Line manager" — get them, but only
//                            if still untouched (never edited, never applied).
//
// No data is written. The free-text StaffProfiles.department / position columns
// stay (they become the display copy, written only from the lists); HR maps
// today's free text to list entries on the one-off tidy screen.
//
// `down`: REFUSES while any department, position or scope row exists (HR typed
// those; dropping them is not lossless). Otherwise drops the two columns (FK
// before index) and the three tables. Guarded both ways; table names compared
// case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000011]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, table) => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};
const dropForeignKeysOn = async (qi, table, column) => {
  const refs = await qi.getForeignKeyReferencesForTable(table);
  for (const r of refs) {
    if (r.columnName === column && r.constraintName) {
      await qi.removeConstraint(table, r.constraintName);
    }
  }
};

// The starter presets' controls that act on people, limited to the holder's own
// department (kept in step with migration …010's lists).
const OWN = { kind: 'own' };
const STARTER_SCOPES = {
  'Nurse in charge': { 'staff.view': OWN, 'hr.view': OWN, 'hr.attendance.amend': OWN, 'leave.view': OWN, 'hr.expiry.alerts': OWN },
  'Line manager': { 'staff.view': OWN, 'hr.view': OWN, 'leave.view': OWN },
};

const listTable = (Sequelize, users, extra = {}) => ({
  id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
  name: { type: Sequelize.STRING(120), allowNull: false },
  ...extra,
  status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  createdById: { type: Sequelize.INTEGER, allowNull: true, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  createdAt: { type: Sequelize.DATE, allowNull: false },
  updatedAt: { type: Sequelize.DATE, allowNull: false },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';

    if (!(await findTable(qi, 'Departments'))) {
      await qi.createTable('Departments', listTable(Sequelize, users));
      await qi.addIndex('Departments', ['name'], { unique: true, name: 'uniq_department_name' });
      console.log(`${TAG} Departments created`);
    }
    if (!(await findTable(qi, 'Positions'))) {
      await qi.createTable('Positions', listTable(Sequelize, users, {
        cadre: { type: Sequelize.ENUM('doctor', 'nurse', 'lab', 'staff'), allowNull: true },
      }));
      await qi.addIndex('Positions', ['name'], { unique: true, name: 'uniq_position_name' });
      console.log(`${TAG} Positions created`);
    }

    const profiles = await findTable(qi, 'StaffProfiles');
    if (profiles) {
      const cols = await qi.describeTable(profiles);
      const departments = await findTable(qi, 'Departments');
      const positions = await findTable(qi, 'Positions');
      if (!cols.departmentId) {
        await qi.addColumn(profiles, 'departmentId', {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: departments, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        });
        await qi.addIndex(profiles, ['departmentId'], { name: 'idx_staffprofile_department' });
      }
      if (!cols.positionId) {
        await qi.addColumn(profiles, 'positionId', {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: positions, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        });
        await qi.addIndex(profiles, ['positionId'], { name: 'idx_staffprofile_position' });
      }
    }

    if (!(await findTable(qi, 'PermissionScopes'))) {
      const departments = await findTable(qi, 'Departments');
      await qi.createTable('PermissionScopes', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId: { type: Sequelize.INTEGER, allowNull: false, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        capability: { type: Sequelize.STRING(64), allowNull: false },
        kind: { type: Sequelize.ENUM('own', 'department'), allowNull: false },
        departmentId: { type: Sequelize.INTEGER, allowNull: true, references: { model: departments, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        setById: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('PermissionScopes', ['UserId', 'capability'], { name: 'idx_scope_user_capability' });
      await qi.addIndex('PermissionScopes', ['UserId', 'capability', 'kind', 'departmentId'], { unique: true, name: 'uniq_scope_row' });
      console.log(`${TAG} PermissionScopes created`);
    }

    const presets = await findTable(qi, 'PermissionPresets');
    if (presets) {
      const cols = await qi.describeTable(presets);
      if (!cols.scopes) {
        await qi.addColumn(presets, 'scopes', { type: Sequelize.JSON, allowNull: true, defaultValue: null });
        for (const [name, scopes] of Object.entries(STARTER_SCOPES)) {
          const [r] = await qi.sequelize.query(
            `UPDATE \`${presets}\` SET scopes = ? WHERE name = ? AND createdById IS NULL AND updatedById IS NULL AND appliedCount = 0 AND scopes IS NULL`,
            { replacements: [JSON.stringify(scopes), name] },
          );
          console.log(`${TAG} starter preset "${name}": own-department limits ${r && r.affectedRows ? 'set' : 'left alone (edited, applied or absent)'}`);
        }
      }
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const scopes = await findTable(qi, 'PermissionScopes');
    const departments = await findTable(qi, 'Departments');
    const positions = await findTable(qi, 'Positions');

    for (const t of [scopes, departments, positions].filter(Boolean)) {
      const n = await count(qi, t);
      if (n > 0) {
        throw new Error(`${TAG} down refused: ${t} has ${n} row(s) HR entered. Restore the database backup instead.`);
      }
    }

    if (scopes) await qi.dropTable(scopes);

    const presets = await findTable(qi, 'PermissionPresets');
    if (presets) {
      const cols = await qi.describeTable(presets);
      if (cols.scopes) {
        const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${presets}\` WHERE scopes IS NOT NULL AND updatedById IS NOT NULL`);
        const n = Number(rows[0].n ?? rows[0].N ?? 0);
        if (n > 0) throw new Error(`${TAG} down refused: ${n} edited preset(s) carry department limits. Restore the database backup instead.`);
        await qi.removeColumn(presets, 'scopes');
      }
    }

    const profiles = await findTable(qi, 'StaffProfiles');
    if (profiles) {
      const cols = await qi.describeTable(profiles);
      for (const [column, index] of [['departmentId', 'idx_staffprofile_department'], ['positionId', 'idx_staffprofile_position']]) {
        if (!cols[column]) continue;
        await dropForeignKeysOn(qi, profiles, column);
        try { await qi.removeIndex(profiles, index); } catch { /* the FK's own index may already be gone */ }
        await qi.removeColumn(profiles, column);
      }
    }

    if (departments) await qi.dropTable(departments);
    if (positions) await qi.dropTable(positions);
  },
};
