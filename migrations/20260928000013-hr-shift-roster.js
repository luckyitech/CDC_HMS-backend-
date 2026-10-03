'use strict';

// HR Suite Tier 3 Phase 4 — the shift roster (Emu, 3 Oct 2026: T3-5 a roster
// drives attendance; T3-6 a nurses, lab and front office; T3-7 a HR-defined
// shifts, warnings only; build defaults RO-1…RO-12).
//
//   RosterShiftTypes  NEW — HR's clinic-wide shift list: name, startTime,
//                     endTime (end ≤ start = runs past midnight), colour,
//                     sortOrder, status active|archived, createdById.
//                     NOT seeded — the clinic's own hours go in by hand.
//   RosterWeeks       NEW — one department's week (departmentId NULL = no
//                     department), weekStart (a Monday), status
//                     draft|published, minCover, publishedAt/ById, createdById.
//   RosterShifts      NEW — one person's cell for one date: UserId, date,
//                     shiftTypeId, isOff, startTime/endTime (copied from the
//                     type), status active|removed, publishedAt, workHoursId
//                     (the dated StaffWorkHours row it wrote when it went
//                     live), createdById, updatedById.
//
// Writes no staff data and changes nobody's hours or access: attendance only
// changes when HR publishes a week (services/roster writes the dated working
// hours then).
//
// `down`: REFUSES while any row exists in any of the three tables (a published
// shift has already become someone's working hours — restore the backup
// instead). Otherwise drops them (shifts first). Guarded both ways; table names
// compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000013]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const count = async (qi, table) => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const users = await findTable(qi, 'Users') || 'Users';
    const departments = await findTable(qi, 'Departments') || 'Departments';
    const userFk = (allowNull, onDelete) => ({
      type: Sequelize.INTEGER, allowNull, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete,
    });
    const stamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!(await findTable(qi, 'RosterShiftTypes'))) {
      await qi.createTable('RosterShiftTypes', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        name: { type: Sequelize.STRING(40), allowNull: false },
        startTime: { type: Sequelize.TIME, allowNull: false },
        endTime: { type: Sequelize.TIME, allowNull: false },
        colour: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'blue' },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('RosterShiftTypes', ['status', 'sortOrder'], { name: 'idx_roster_type_status' });
      console.log(`${TAG} RosterShiftTypes created`);
    }

    if (!(await findTable(qi, 'RosterWeeks'))) {
      await qi.createTable('RosterWeeks', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        departmentId: { type: Sequelize.INTEGER, allowNull: true, references: { model: departments, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        weekStart: { type: Sequelize.DATEONLY, allowNull: false },
        status: { type: Sequelize.ENUM('draft', 'published'), allowNull: false, defaultValue: 'draft' },
        minCover: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        publishedAt: { type: Sequelize.DATE, allowNull: true },
        publishedById: userFk(true, 'SET NULL'),
        createdById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('RosterWeeks', ['weekStart', 'departmentId'], { name: 'idx_roster_week_start' });
      console.log(`${TAG} RosterWeeks created`);
    }

    if (!(await findTable(qi, 'RosterShifts'))) {
      const types = await findTable(qi, 'RosterShiftTypes');
      const hours = await findTable(qi, 'StaffWorkHours') || 'StaffWorkHours';
      await qi.createTable('RosterShifts', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId: userFk(false, 'CASCADE'),
        date: { type: Sequelize.DATEONLY, allowNull: false },
        shiftTypeId: { type: Sequelize.INTEGER, allowNull: true, references: { model: types, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        isOff: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        startTime: { type: Sequelize.TIME, allowNull: true },
        endTime: { type: Sequelize.TIME, allowNull: true },
        status: { type: Sequelize.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
        publishedAt: { type: Sequelize.DATE, allowNull: true },
        workHoursId: { type: Sequelize.INTEGER, allowNull: true, references: { model: hours, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
        createdById: userFk(true, 'SET NULL'),
        updatedById: userFk(true, 'SET NULL'),
        ...stamps,
      });
      await qi.addIndex('RosterShifts', ['UserId', 'date', 'status'], { name: 'idx_roster_shift_user_date' });
      await qi.addIndex('RosterShifts', ['date', 'status'], { name: 'idx_roster_shift_date' });
      console.log(`${TAG} RosterShifts created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const shifts = await findTable(qi, 'RosterShifts');
    const weeks = await findTable(qi, 'RosterWeeks');
    const types = await findTable(qi, 'RosterShiftTypes');
    for (const [table, what] of [[shifts, 'roster cell(s)'], [weeks, 'roster week(s)'], [types, 'shift type(s)']]) {
      if (!table) continue;
      const n = await count(qi, table);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} ${what} exist. Restore the database backup instead.`);
    }
    if (shifts) await qi.dropTable(shifts);
    if (weeks) await qi.dropTable(weeks);
    if (types) await qi.dropTable(types);
  },
};
