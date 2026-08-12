/**
 * Rebuild the staff leave and document tables.
 *
 *   node scripts/reset-staff-tables.js
 *
 * Why this exists: sequelize.sync() runs on every boot and creates any missing
 * table from the model as it stood at that moment. On a new feature it usually
 * beats the migration to it — and the migration then finds the table present,
 * skips, and records itself as run. The result is a table missing whatever the
 * migration would have added, with `db:migrate` insisting everything is up to
 * date.
 *
 * This drops those tables and forgets their migrations, so `npm run migrate`
 * builds them properly. It REFUSES to run if any of them holds data, so it
 * cannot be used to wipe real records by accident.
 *
 * Uses the app's own connection, so it needs no mysql client on PATH.
 */

require('dotenv').config();
const sequelize = require('../config/database');

const TABLES = ['StaffLeaves', 'LeaveBalances', 'StaffDocuments'];

const MIGRATION_PATTERNS = ['%staff-leaves%', '%staff-documents%'];

(async () => {
  try {
    await sequelize.authenticate();
    const qi = sequelize.getQueryInterface();

    const existing = (await qi.showAllTables())
      .map((t) => (typeof t === 'string' ? t : t.tableName));

    const present = TABLES.filter((t) =>
      existing.some((e) => e.toLowerCase() === t.toLowerCase()));

    if (!present.length) {
      console.log('None of the staff tables exist yet — just run: npm run migrate');
      process.exit(0);
    }

    // Refuse to destroy anything that holds records.
    for (const table of present) {
      const [[{ count }]] = await sequelize.query(`SELECT COUNT(*) AS count FROM ${table}`);
      console.log(`  ${table}: ${count} row(s)`);
      if (Number(count) > 0) {
        console.error(
          `\nRefusing to continue: ${table} contains data.\n` +
          'Back it up and drop the table by hand if you really mean to rebuild it.'
        );
        process.exit(1);
      }
    }

    // Order matters only if foreign keys point between them; dropped together
    // with checks off to keep this simple and order-independent.
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of present) {
      await qi.dropTable(table);
      console.log(`  dropped ${table}`);
    }
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

    for (const pattern of MIGRATION_PATTERNS) {
      const [result] = await sequelize.query(
        'DELETE FROM SequelizeMeta WHERE name LIKE :pattern',
        { replacements: { pattern } }
      );
      console.log(`  cleared migration record ${pattern}`);
    }

    console.log('\nDone. Now run:  npm run migrate');
    process.exit(0);
  } catch (err) {
    console.error('\nFailed:', err.message);
    process.exit(1);
  }
})();
