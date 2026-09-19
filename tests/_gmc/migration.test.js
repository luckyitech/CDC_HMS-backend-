require('dotenv').config({ path: '.env.test', override: true });
// SAFETY: these scripts call sequelize.sync({ force: true }) — that DROPS EVERY
// TABLE in whatever database .env.test names. They must never run against a
// developer's or the clinic's database. Run only via `npm run test:gmc` with a
// .env.test that points at an EMPTY throwaway database AND sets
// CONFIRM_TEST_DB=1 (the same guard test-admission-flow.js uses).
if (process.env.CONFIRM_TEST_DB !== '1' || !process.env.DB_NAME || /prod|cdc_hms$/i.test(process.env.DB_NAME)) {
  console.error(`[gmc test] refusing to run: DB_NAME="${process.env.DB_NAME || ''}" CONFIRM_TEST_DB="${process.env.CONFIRM_TEST_DB || ''}". `
    + 'Point .env.test at an empty test database and set CONFIRM_TEST_DB=1.');
  process.exit(0);
}
const { Sequelize } = require('sequelize');
const db = require('../../models');
const mig = require('../../migrations/20260912000001-create-glucose-management-centre');
(async () => {
  const qi = db.sequelize.getQueryInterface();
  await db.sequelize.authenticate();
  // Base schema from the models (first-deploy style), then drop OUR three so the migration creates them.
  await db.sequelize.sync({ force: true });
  await qi.dropTable('GlucoseMeterReadings'); await qi.dropTable('PatientGlucoseTargets'); await qi.dropTable('PatientMeters');
  const has = async (t) => (await qi.showAllTables()).map(String).includes(t);
  await mig.up(qi, Sequelize);  console.log('up   →', await has('GlucoseMeterReadings'), await has('PatientMeters'), await has('PatientGlucoseTargets'));
  await mig.up(qi, Sequelize);  console.log('up×2 → idempotent ok');
  await mig.down(qi);           console.log('down →', await has('GlucoseMeterReadings'), await has('PatientMeters'), await has('PatientGlucoseTargets'));
  await mig.up(qi, Sequelize);  console.log('up   → restored');
  const d = await qi.describeTable('GlucoseMeterReadings'); console.log('cols:', Object.keys(d).length, 'measuredAt', d.measuredAt.type, 'glucoseMgdl', d.glucoseMgdl.type);
  const idx = await qi.showIndex('GlucoseMeterReadings'); console.log('indexes:', idx.map(i=>i.name).join(', '));
  await db.sequelize.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
