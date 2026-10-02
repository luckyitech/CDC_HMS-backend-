'use strict';

// B27 phase 2 (Apply) — a leave request's timeline can say the applicant added
// the supporting document they owed (Emu, 28 Sep 2026: a type that needs a
// document may be submitted with it owed and the document added later).
//
//   LeaveEvents.type ENUM  + 'document_added'
//
// `down` REFUSES while any row uses 'document_added': narrowing the ENUM would
// make MySQL rewrite those rows to '' (or fail under strict mode), and the
// timeline is never edited. Restore the backup instead.
//
// Guarded both ways; table names compared case-insensitively (the VDS returns
// them lowercase).

const OLD_TYPES = ['submitted', 'approved', 'declined', 'info_requested', 'info_replied', 'charge_changed',
  'withdrawn', 'cancel_requested', 'cancelled', 'recorded', 'notified'];
const NEW_TYPES = [...OLD_TYPES, 'document_added'];

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const hasValue = (column, value) => String(column?.type || '').includes(`'${value}'`)
  || (Array.isArray(column?.special) && column.special.includes(value));

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await findTable(queryInterface, 'LeaveEvents');
    if (!table) return;
    const cols = await queryInterface.describeTable(table);
    if (!cols.type || hasValue(cols.type, 'document_added')) return;
    await queryInterface.changeColumn(table, 'type', { type: Sequelize.ENUM(...NEW_TYPES), allowNull: false });
  },

  async down(queryInterface, Sequelize) {
    const table = await findTable(queryInterface, 'LeaveEvents');
    if (!table) return;
    const cols = await queryInterface.describeTable(table);
    if (!cols.type || !hasValue(cols.type, 'document_added')) return;
    const [rows] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE type = 'document_added'`
    );
    const n = Number(rows[0].n || rows[0].N || 0);
    if (n > 0) {
      throw new Error(`[20260928000008] down refused: ${n} leave timeline entr${n === 1 ? 'y says' : 'ies say'} `
        + '"document added" — narrowing the column would lose them. Restore the backup instead.');
    }
    await queryInterface.changeColumn(table, 'type', { type: Sequelize.ENUM(...OLD_TYPES), allowNull: false });
  },
};
