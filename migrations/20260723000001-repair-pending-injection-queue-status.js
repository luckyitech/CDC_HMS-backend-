'use strict';

/**
 * Repair: ensure 'Pending Injection' exists in Queues.status.
 *
 * Migration 20260722000009 adds this value, but its table-exists guard used
 * tables.map(String), which turns the { tableName } objects returned by
 * showAllTables() into '[object Object]' — so the guard always "failed",
 * the migration skipped its ALTER, and sequelize-cli still recorded it as
 * migrated. Sequelize then skips 009 forever and every write of 'Pending
 * Injection' fails under STRICT_TRANS_TABLES, which surfaces to the doctor
 * as a generic error when sending a patient for their injection.
 *
 * This migration checks the actual column definition rather than trusting
 * SequelizeMeta. On a healthy database (including the server, where 009 runs
 * normally right before this) it is a no-op; on a drifted one it re-applies
 * the ALTER. Safe to run anywhere, changes no data.
 */

const STATUSES = [
  'Awaiting Triage', 'In Triage', 'Awaiting Doctor', 'With Doctor',
  'Pending Injection', 'Pending Billing', 'Completed', 'Removed',
];

const enumSql = (values) =>
  `ENUM(${values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`;

module.exports = {
  async up(queryInterface) {
    // showAllTables() returns strings or { tableName } objects depending on
    // the sequelize version — mapping through String() turns the objects into
    // '[object Object]' and made this guard silently skip the whole migration.
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('queues')) {
      console.log('Queues table not found — skipping');
      return;
    }

    const [rows] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`Queues\` LIKE 'status'`
    );
    const columnType = rows?.[0]?.Type || '';
    if (columnType.includes('Pending Injection')) {
      console.log("Queues.status already has 'Pending Injection' — nothing to repair");
      return;
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE \`Queues\` MODIFY COLUMN \`status\` ${enumSql(STATUSES)} ` +
      `NOT NULL DEFAULT 'Awaiting Triage'`
    );
    console.log("Repaired Queues.status — 'Pending Injection' added");
  },

  // Intentionally a no-op: removing the value is 20260722000009's down(),
  // which refuses while any row still holds 'Pending Injection'. Undoing a
  // repair independently would just reintroduce the drift this fixes.
  async down() {},
};
