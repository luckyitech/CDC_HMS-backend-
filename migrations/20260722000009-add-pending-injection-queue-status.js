'use strict';

/**
 * Adds 'Pending Injection' to Queues.status.
 *
 * A patient sent from the doctor to the nurse for their weekly GLP-1 injection
 * has finished the consultation but has not been billed. Previously this was
 * derived from 'Awaiting Triage' + a reason string, which meant injection
 * visits could not be counted in SQL. This makes it a real status so it is
 * reportable.
 *
 * ── DEPLOY ORDER MATTERS ────────────────────────────────────────────────────
 * This migration MUST run before any frontend that writes 'Pending Injection'
 * reaches users, otherwise those writes fail validation. The standard sequence
 * already does this correctly:
 *     git pull → npm install → npm run migrate → pm2 restart cdc-hms-api
 * Deploy the backend first, then the frontend build.
 *
 * The change is additive: no existing row changes value, and reads of every
 * other status are unaffected. Rolling back is only safe while no row holds
 * the new value, which the down() checks for and refuses otherwise.
 */

const STATUSES_BEFORE = [
  'Awaiting Triage', 'In Triage', 'Awaiting Doctor', 'With Doctor',
  'Pending Billing', 'Completed', 'Removed',
];

// 'Pending Injection' sits after 'With Doctor' — the patient has left the
// doctor but is not yet at the cashier.
const STATUSES_AFTER = [
  'Awaiting Triage', 'In Triage', 'Awaiting Doctor', 'With Doctor',
  'Pending Injection', 'Pending Billing', 'Completed', 'Removed',
];

const enumSql = (values) =>
  `ENUM(${values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')})`;

module.exports = {
  async up(queryInterface) {
    // showAllTables() may return { tableName } objects rather than strings;
    // String() on those gives '[object Object]', so map explicitly.
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('queues')) {
      console.log('Queues table not found — skipping');
      return;
    }

    // Guard: if the value is already present this migration is a no-op. Checks
    // the column definition itself, not just that the table exists, so a
    // stray sync() cannot make this silently skip real work.
    const [rows] = await queryInterface.sequelize.query(
      `SHOW COLUMNS FROM \`Queues\` LIKE 'status'`
    );
    const columnType = rows?.[0]?.Type || '';
    if (columnType.includes('Pending Injection')) {
      console.log("Queues.status already has 'Pending Injection' — skipping");
      return;
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE \`Queues\` MODIFY COLUMN \`status\` ${enumSql(STATUSES_AFTER)} ` +
      `NOT NULL DEFAULT 'Awaiting Triage'`
    );
    console.log("Added 'Pending Injection' to Queues.status");
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('queues')) return;

    // Refuse to drop the value while rows still hold it — silently rewriting a
    // patient's queue state during a rollback would lose clinical context.
    const [[{ count }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS count FROM \`Queues\` WHERE \`status\` = 'Pending Injection'`
    );
    if (Number(count) > 0) {
      throw new Error(
        `Cannot roll back: ${count} queue row(s) still have status 'Pending Injection'. ` +
        `Move them to 'Pending Billing' or 'Completed' first.`
      );
    }

    await queryInterface.sequelize.query(
      `ALTER TABLE \`Queues\` MODIFY COLUMN \`status\` ${enumSql(STATUSES_BEFORE)} ` +
      `NOT NULL DEFAULT 'Awaiting Triage'`
    );
  },
};
