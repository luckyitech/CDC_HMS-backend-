/* Verifies the 6 thyroid migrations against a live DB:
 *   minimal base tables → up ×6 → describe → down ×6 → up ×6 (round-trip).
 * Run: DB_* env set to the local MariaDB. */
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'cdc';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'cdc';
process.env.DB_NAME = process.env.DB_NAME || 'cdc_hms';

const { Sequelize } = require('sequelize');
const path = require('path');
const fs = require('fs');

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: process.env.DB_PORT, dialect: 'mysql', logging: false,
});
const qi = sequelize.getQueryInterface();
const S = Sequelize;

const MIGRATIONS = [
  '20260819000001-create-thyroid-ultrasounds.js',
  '20260819000002-create-thyroid-nodules.js',
  '20260819000003-create-thyroid-follicular-assessments.js',
  '20260819000004-create-thyroid-us-catalog-items.js',
  '20260819000005-seed-thyroid-us-catalog.js',
  '20260819000006-create-thyroid-ultrasound-images.js',
];

async function stub(name) {
  const tables = await qi.showAllTables().then((t) => t.map((x) => x.toLowerCase()));
  if (tables.includes(name.toLowerCase())) return;
  await qi.createTable(name, { id: { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false } });
}

(async () => {
  try {
    await sequelize.authenticate();
    // clean slate
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['ThyroidUltrasoundImages', 'ThyroidNoduleFollicularAssessments', 'ThyroidNodules', 'ThyroidUltrasounds', 'ThyroidUsCatalogItems', 'UltrasoundImages', 'Patients', 'Users']) {
      await sequelize.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

    // minimal FK-target base tables
    await stub('Users'); await stub('Patients'); await stub('UltrasoundImages');
    console.log('base tables ready');

    const load = (f) => require(path.join(__dirname, '..', 'migrations', f));

    // UP ×6
    for (const f of MIGRATIONS) { await load(f).up(qi, S); console.log('up  ✓', f); }

    // describe key tables
    const rep = await qi.describeTable('ThyroidUltrasounds');
    const nod = await qi.describeTable('ThyroidNodules');
    const img = await qi.describeTable('ThyroidUltrasoundImages');
    console.log('ThyroidUltrasounds columns:', Object.keys(rep).length);
    console.log('ThyroidNodules columns:', Object.keys(nod).length);
    console.log('ThyroidUltrasoundImages columns:', Object.keys(img).length);
    // spot-check a few critical columns
    ['reportNumber', 'reportedById', 'reportSnapshot', 'tiradsVersion', 'noNodules'].forEach((c) => { if (!rep[c]) throw new Error('missing report col ' + c); });
    ['tiradsCategory', 'btaCategory', 'fociPunctate', 'follicularIndicated'].forEach((c) => { if (!nod[c]) throw new Error('missing nodule col ' + c); });
    ['UltrasoundImageId', 'brightness', 'orderIndex'].forEach((c) => { if (!img[c]) throw new Error('missing image col ' + c); });

    // seed check
    const [seed] = await sequelize.query("SELECT type, COUNT(*) n FROM ThyroidUsCatalogItems GROUP BY type");
    console.log('catalog seed:', JSON.stringify(seed));

    // DOWN ×6 (reverse)
    for (const f of [...MIGRATIONS].reverse()) { await load(f).down(qi, S); console.log('down ✓', f); }
    // UP ×6 again (round-trip)
    for (const f of MIGRATIONS) { await load(f).up(qi, S); }
    console.log('round-trip up→down→up ✓');

    console.log('\nMIGRATIONS VERIFIED OK');
    await sequelize.close();
  } catch (e) {
    console.error('MIGRATION VERIFY FAILED:', e.message);
    console.error(e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : '');
    process.exit(1);
  }
})();
