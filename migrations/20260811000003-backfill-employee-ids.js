'use strict';

// Staff Profiles Phase 1 (3/3) — assign EMP### to every existing profile, then
// add the unique index. See STAFF_PROFILE_DESIGN.md.
//
// IDs are assigned in createdAt order so the longest-serving staff hold the
// lowest numbers, which is what people expect of a staff number.
//
// The index is added AFTER the backfill: adding it first would reject the
// second row the moment two profiles still shared a NULL... except MySQL
// permits multiple NULLs in a unique index, which would let the backfill
// silently leave duplicates if it half-ran. Ordering it this way means the
// index creation itself is the check that the backfill worked.

const TABLE = 'StaffProfiles';
const INDEX = 'unique_employee_id';

const format = (n) => `EMP${String(n).padStart(3, '0')}`;

// Tables come from sequelize.sync() in this project; nothing to do if the table
// has not been created yet.
const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface) {
    if (!(await tableExists(queryInterface))) return;

    const [rows] = await queryInterface.sequelize.query(`
      SELECT id FROM ${TABLE}
      WHERE employeeId IS NULL OR employeeId = ''
      ORDER BY createdAt ASC, id ASC
    `);

    // Continue from the highest existing number rather than restarting at 1,
    // so a partial previous run cannot produce a collision.
    const [[{ maxNum } = {}]] = await queryInterface.sequelize.query(`
      SELECT MAX(CAST(SUBSTRING(employeeId, 4) AS UNSIGNED)) AS maxNum
      FROM ${TABLE}
      WHERE employeeId REGEXP '^EMP[0-9]+$'
    `);

    let next = (Number(maxNum) || 0) + 1;

    for (const row of rows) {
      await queryInterface.sequelize.query(
        `UPDATE ${TABLE} SET employeeId = :employeeId WHERE id = :id`,
        { replacements: { employeeId: format(next), id: row.id } }
      );
      next += 1;
    }

    const indexes = await queryInterface.showIndex(TABLE);
    const exists = indexes.some((i) => i.name === INDEX);
    if (!exists) {
      await queryInterface.addIndex(TABLE, {
        fields: ['employeeId'],
        unique: true,
        name: INDEX,
      });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;

    const indexes = await queryInterface.showIndex(TABLE);
    if (indexes.some((i) => i.name === INDEX)) {
      await queryInterface.removeIndex(TABLE, INDEX);
    }
    await queryInterface.sequelize.query(`UPDATE ${TABLE} SET employeeId = NULL`);
  },
};
