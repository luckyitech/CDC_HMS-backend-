// HR Suite (B21) — scratch-DB preparation. RUN ONLY against a throw-away DB
// (CONFIRM_TEST_DB=1, DB_NAME containing "scratch"/"test"): it sync({force})s.
//
// Build the schema the way prod was built (sync), then put it in the state
// prod will be in when `npm run migrate` runs: HR tables absent, method column
// absent, SequelizeMeta baselined through 20260923000002.
require('dotenv').config();
require('../_guard').assertThrowawayDb('hr prep', 1);
const fs = require('fs');
const db = require('../../models');
(async () => {
  await db.sequelize.sync({ force: true });
  const qi = db.sequelize.getQueryInterface();
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=0');
  for (const t of ['StaffAttendances', 'StaffWorkHours', 'UserDevices', 'HrNfcTags']) await qi.dropTable(t);
  await db.sequelize.query('SET FOREIGN_KEY_CHECKS=1');
  await qi.removeColumn('UserLoginLogs', 'method');
  await db.sequelize.query('CREATE TABLE IF NOT EXISTS SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY)');
  const files = fs.readdirSync('./migrations').filter((f) => f.endsWith('.js') && f < '20260923000003').sort();
  for (const f of files) await db.sequelize.query('INSERT IGNORE INTO SequelizeMeta (name) VALUES (?)', { replacements: [f] });
  const tables = await qi.showAllTables();
  console.log('tables:', tables.length, 'baselined:', files.length, 'HR tables present:', tables.filter((t) => /HrNfc|StaffAttend|UserDevice|StaffWork/.test(t)));
  console.log('UserLoginLogs.method present:', Object.keys(await qi.describeTable('UserLoginLogs')).includes('method'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
