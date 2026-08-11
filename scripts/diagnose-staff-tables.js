/**
 * Diagnostic for the staff-profiles branch.
 *
 * Prints what actually exists in the database versus what the models expect,
 * and which migrations are recorded as run. Read-only — it changes nothing.
 *
 *   node scripts/diagnose-staff-tables.js
 */

require('dotenv').config();
const sequelize = require('../config/database');
const db = require('../models');

const TABLES = ['StaffProfiles', 'StaffLeaves', 'LeaveBalances', 'StaffDocuments'];

const MODEL_FOR_TABLE = {
  StaffProfiles:  'StaffProfile',
  StaffLeaves:    'StaffLeave',
  LeaveBalances:  'LeaveBalance',
  StaffDocuments: 'StaffDocument',
};

(async () => {
  try {
    await sequelize.authenticate();
    const qi = sequelize.getQueryInterface();

    const all = (await qi.showAllTables())
      .map((t) => (typeof t === 'string' ? t : t.tableName));

    console.log('\n=== Migrations recorded as run ===');
    try {
      const [rows] = await sequelize.query(
        "SELECT name FROM SequelizeMeta WHERE name LIKE '202608%' ORDER BY name"
      );
      if (!rows.length) console.log('  (none from August 2026)');
      rows.forEach((r) => console.log('  ' + r.name));
    } catch {
      console.log('  SequelizeMeta not found — migrations have never run');
    }

    console.log('\n=== Tables ===');
    for (const table of TABLES) {
      const exists = all.some((t) => t.toLowerCase() === table.toLowerCase());
      if (!exists) {
        console.log(`\n  ${table}: DOES NOT EXIST`);
        continue;
      }

      const described = await qi.describeTable(table);
      const dbColumns = Object.keys(described);

      const model = db[MODEL_FOR_TABLE[table]];
      const modelColumns = model ? Object.keys(model.rawAttributes) : [];

      const missing = modelColumns.filter((c) => !dbColumns.includes(c));
      const extra   = dbColumns.filter((c) => !modelColumns.includes(c));

      console.log(`\n  ${table}: ${dbColumns.length} columns`);
      console.log('    columns: ' + dbColumns.join(', '));
      if (missing.length) console.log('    >>> MISSING (model has, table does not): ' + missing.join(', '));
      if (extra.length)   console.log('    (table has, model does not): ' + extra.join(', '));

      const indexes = await qi.showIndex(table);
      console.log('    indexes: ' + (indexes.map((i) => i.name).join(', ') || 'none'));
    }

    // The index sync tries to build on boot, and the usual cause of
    // "Key column 'X' doesn't exist in table" — an index naming a column that
    // is not on the table it belongs to.
    console.log('\n=== Model indexes that would fail on boot ===');
    let broken = 0;
    for (const [name, model] of Object.entries(db)) {
      if (!model || !model.rawAttributes || !model.options) continue;
      const attrs = Object.keys(model.rawAttributes);

      for (const idx of model.options.indexes || []) {
        for (const field of idx.fields || []) {
          const col = typeof field === 'string' ? field : field.name;
          if (!attrs.includes(col)) {
            console.log(`  ${name}: index "${idx.name || '(unnamed)'}" names column "${col}", which the model does not have`);
            broken++;
          }
        }
      }
    }
    if (!broken) console.log('  none');

    console.log('');
    process.exit(0);
  } catch (err) {
    console.error('\nDiagnostic failed:', err.message);
    process.exit(1);
  }
})();
