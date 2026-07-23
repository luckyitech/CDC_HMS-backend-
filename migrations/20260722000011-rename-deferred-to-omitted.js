'use strict';

/**
 * Renames the Glp1Administrations.status value 'deferred' to 'omitted'.
 *
 * A weekly GLP-1 injection that did not happen is either 'missed' (the patient
 * did not take it) or 'omitted' (deliberately held). 'Deferred' read as merely
 * postponed, which is not the clinical meaning the clinic wants recorded. This
 * is a value rename, not a new status — the set stays three wide.
 *
 * The change is done as expand → migrate rows → contract, so no row holding the
 * old value is ever blanked by a straight ENUM narrowing:
 *   1. widen the ENUM to the superset {given, missed, deferred, omitted}
 *   2. move every 'deferred' row to 'omitted'
 *   3. narrow the ENUM to the final {given, missed, omitted}
 *
 * Guards on the column definition (SHOW COLUMNS), not just the table name, so a
 * stray sync() that rebuilt the table cannot make this silently skip its work.
 * Not in production yet — but written to run cleanly on a local DB that already
 * created the table with the old value.
 */

const enumSql = (values) =>
  `ENUM(${values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`;

const FINAL   = ['given', 'missed', 'omitted'];
const SUPERSET = ['given', 'missed', 'deferred', 'omitted'];
const BEFORE  = ['given', 'missed', 'deferred'];

const columnType = async (queryInterface) => {
  const [rows] = await queryInterface.sequelize.query(
    `SHOW COLUMNS FROM \`Glp1Administrations\` LIKE 'status'`
  );
  return rows?.[0]?.Type || '';
};

module.exports = {
  async up(queryInterface) {
    // showAllTables() may return { tableName } objects rather than strings;
    // String() on those gives '[object Object]', so map explicitly.
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('glp1administrations')) {
      console.log('Glp1Administrations table not found — skipping');
      return;
    }

    const type = await columnType(queryInterface);
    if (type.includes("'omitted'") && !type.includes("'deferred'")) {
      console.log("Glp1Administrations.status already uses 'omitted' — skipping");
      return;
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE \`Glp1Administrations\` MODIFY COLUMN \`status\` ${enumSql(SUPERSET)} NOT NULL`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`Glp1Administrations\` SET \`status\` = 'omitted' WHERE \`status\` = 'deferred'`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE \`Glp1Administrations\` MODIFY COLUMN \`status\` ${enumSql(FINAL)} NOT NULL`
    );
    console.log("Renamed Glp1Administrations.status 'deferred' → 'omitted'");
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('glp1administrations')) return;

    const type = await columnType(queryInterface);
    if (type.includes("'deferred'") && !type.includes("'omitted'")) {
      console.log("Glp1Administrations.status already uses 'deferred' — skipping");
      return;
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE \`Glp1Administrations\` MODIFY COLUMN \`status\` ${enumSql(SUPERSET)} NOT NULL`
    );
    await queryInterface.sequelize.query(
      `UPDATE \`Glp1Administrations\` SET \`status\` = 'deferred' WHERE \`status\` = 'omitted'`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE \`Glp1Administrations\` MODIFY COLUMN \`status\` ${enumSql(BEFORE)} NOT NULL`
    );
  },
};
