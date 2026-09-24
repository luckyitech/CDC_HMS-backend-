// Read-only diagnostic: who is missing a StaffProfile, and what the old
// per-cadre profile tables still hold. Prints counts only; changes nothing.
const db = require('../models');
const STAFF_ROLES = ['doctor', 'nurse', 'lab', 'staff', 'admin'];

(async () => {
  await db.sequelize.authenticate();
  const q = (sql) => db.sequelize.query(sql, { type: db.sequelize.QueryTypes.SELECT });

  const showTables = await db.sequelize.query('SHOW TABLES', { type: db.sequelize.QueryTypes.SELECT });
  const tables = showTables.map((r) => Object.values(r)[0]);
  const has = (t) => tables.includes(t);

  console.log('\n=== Users by role ===');
  console.log(JSON.stringify(await q("SELECT role, COUNT(*) n FROM Users GROUP BY role")));

  console.log('\n=== StaffProfiles ===');
  console.log('total:', (await q("SELECT COUNT(*) n FROM StaffProfiles"))[0].n);
  console.log('with employeeId:', (await q("SELECT COUNT(*) n FROM StaffProfiles WHERE employeeId IS NOT NULL"))[0].n);
  console.log('not archived:', (await q("SELECT COUNT(*) n FROM StaffProfiles WHERE deletedAt IS NULL"))[0].n);

  console.log('\n=== Staff-role users WITHOUT a StaffProfile (these are invisible in the directory) ===');
  const missing = await q(
    "SELECT u.id, u.role, u.email, u.firstName, u.lastName FROM Users u " +
    "LEFT JOIN StaffProfiles sp ON sp.UserId = u.id " +
    "WHERE u.role IN ('doctor','nurse','lab','staff','admin') AND sp.id IS NULL"
  );
  console.log('count:', missing.length);
  missing.forEach((m) => console.log(`  ${m.role.padEnd(6)} ${m.email} (${m.firstName} ${m.lastName})`));

  console.log('\n=== Old per-cadre tables (audit says dead) ===');
  if (has('DoctorProfiles')) console.log('DoctorProfiles rows:', (await q("SELECT COUNT(*) n FROM DoctorProfiles"))[0].n);
  else console.log('DoctorProfiles: table absent');
  if (has('LabTechProfiles')) console.log('LabTechProfiles rows:', (await q("SELECT COUNT(*) n FROM LabTechProfiles"))[0].n);
  else console.log('LabTechProfiles: table absent');

  console.log('');
  process.exit(0);
})().catch((e) => { console.error('audit failed:', e.message); process.exit(1); });
