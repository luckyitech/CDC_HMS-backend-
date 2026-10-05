'use strict';

// HR Suite → Manual (5 Oct 2026) — the clinic's ONE shared HR checklist: the
// go-live setup steps and the first-week walkthrough from the HR Suite
// Manual, ticked by HR staff, plus items HR adds.
//
//   HrChecklistItems   NEW — current state of one item: itemKey (unique; the
//                      stable key from the frontend content module, or
//                      "custom-…" for an item HR added), section, label (custom
//                      items only), isCustom, done/doneById/doneAt,
//                      note/noteById/noteAt, status active|archived,
//                      createdById, archivedById/archivedAt.
//   HrChecklistEvents  NEW — append-only history: itemKey, action
//                      tick|untick|note|add|archive|restore, byId, detail,
//                      createdAt. An untick never erases who ticked.
//
// Touches no existing table and seeds nothing (built-in items get their row
// the first time someone ticks one).
//
// `down`: REFUSES while either table has any row (ticks, notes and their
// history would be lost — restore the backup instead), like 013/014. Drops
// both tables (events first) only when they are empty. Guarded both ways;
// table names compared case-insensitively (the VDS returns them lowercase).

const TAG = '[20260928000018]';

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
    const userFk = () => ({
      type: Sequelize.INTEGER, allowNull: true, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });

    if (!(await findTable(qi, 'HrChecklistItems'))) {
      await qi.createTable('HrChecklistItems', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        itemKey: { type: Sequelize.STRING(64), allowNull: false, unique: true },
        section: { type: Sequelize.STRING(20), allowNull: false },
        label: { type: Sequelize.STRING(300), allowNull: true },
        isCustom: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        done: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        doneById: userFk(),
        doneAt: { type: Sequelize.DATE, allowNull: true },
        note: { type: Sequelize.STRING(500), allowNull: true },
        noteById: userFk(),
        noteAt: { type: Sequelize.DATE, allowNull: true },
        status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        createdById: userFk(),
        archivedById: userFk(),
        archivedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      console.log(`${TAG} HrChecklistItems created`);
    }

    if (!(await findTable(qi, 'HrChecklistEvents'))) {
      await qi.createTable('HrChecklistEvents', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        itemKey: { type: Sequelize.STRING(64), allowNull: false },
        action: { type: Sequelize.ENUM('tick', 'untick', 'note', 'add', 'archive', 'restore'), allowNull: false },
        byId: userFk(),
        detail: { type: Sequelize.STRING(500), allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('HrChecklistEvents', ['itemKey', 'createdAt'], { name: 'idx_hr_checklist_event_item' });
      console.log(`${TAG} HrChecklistEvents created`);
    }
  },

  async down(queryInterface) {
    const qi = queryInterface;
    const events = await findTable(qi, 'HrChecklistEvents');
    const items = await findTable(qi, 'HrChecklistItems');
    for (const [table, what] of [[events, 'checklist history row(s)'], [items, 'checklist item(s)']]) {
      if (!table) continue;
      const n = await count(qi, table);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} ${what} exist. Restore the database backup instead.`);
    }
    if (events) await qi.dropTable(events);
    if (items) await qi.dropTable(items);
    console.log(`${TAG} HrChecklistEvents and HrChecklistItems dropped (both were empty)`);
  },
};
