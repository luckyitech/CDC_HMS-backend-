require('dotenv').config({ path: '.env.test', override: true });
const { Sequelize } = require('sequelize');
const db = require('../../models');
const mig = require('../../migrations/20260913000001-create-patient-diary-events');
(async () => {
  const qi = db.sequelize.getQueryInterface();
  await db.sequelize.authenticate();
  await db.sequelize.sync({ force: true });
  await qi.dropTable('PatientDiaryEvents');
  const has = async (t) => (await qi.showAllTables()).map(String).includes(t);
  await mig.up(qi, Sequelize);  console.log('up   →', await has('PatientDiaryEvents'));
  await mig.up(qi, Sequelize);  console.log('up×2 → idempotent ok');
  await mig.down(qi);           console.log('down →', await has('PatientDiaryEvents'));
  await mig.up(qi, Sequelize);  console.log('up   → restored', await has('PatientDiaryEvents'));
  const d = await qi.describeTable('PatientDiaryEvents');
  console.log('cols:', Object.keys(d).length, '| eventType', d.eventType.type, '| occurredAt', d.occurredAt.type, '| detail', d.detail.type);
  const idx = await qi.showIndex('PatientDiaryEvents'); console.log('indexes:', idx.map((i) => i.name).join(', '));
  await db.sequelize.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
