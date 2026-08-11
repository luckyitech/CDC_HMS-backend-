'use strict';

// Staff Profiles Phase 1 (2/3) — copy DoctorProfiles and LabTechProfiles into
// StaffProfiles so one table holds every cadre. See STAFF_PROFILE_DESIGN.md.
//
// The source tables are left untouched and are NOT dropped: they stay readable
// for one release as a safety net, and this migration is re-runnable because it
// skips any user who already has a StaffProfile row.
//
// Field mapping (names diverged across the three tables):
//   doctor: medicalSchool -> institution, subSpecialty -> roleDetails
//   lab:    certificationNumber -> licenseNumber, specialization -> specialty

const now = () => new Date();

// Tables are created by sequelize.sync() in this project, so on a fresh
// database none of these may exist yet — and a fresh database has nothing to
// backfill anyway.
const tablesExist = async (qi, names) => {
  const tables = (await qi.showAllTables())
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase());
  return names.every((n) => tables.includes(n.toLowerCase()));
};

// JSON columns round-trip as strings on some MySQL/Sequelize combinations, so
// stringify explicitly rather than relying on the driver to serialise.
const asJson = (value) => JSON.stringify(value ?? {});

module.exports = {
  async up(queryInterface) {
    const required = ['StaffProfiles', 'DoctorProfiles', 'LabTechProfiles', 'Users'];
    if (!(await tablesExist(queryInterface, required))) return;

    const [existing] = await queryInterface.sequelize.query(
      'SELECT UserId FROM StaffProfiles WHERE UserId IS NOT NULL'
    );
    const alreadyHasProfile = new Set(existing.map((r) => r.UserId));

    const rows = [];

    // ---- Doctors ----
    const [doctors] = await queryInterface.sequelize.query(`
      SELECT dp.*, u.id AS userId
      FROM DoctorProfiles dp
      JOIN Users u ON u.id = dp.UserId
    `);

    for (const d of doctors) {
      if (alreadyHasProfile.has(d.userId)) continue;
      rows.push({
        UserId:           d.userId,
        position:         'Doctor',
        department:       d.department || null,
        shift:            null,
        startDate:        d.startDate || null,
        address:          d.address || null,
        city:             d.city || null,
        employmentType:   d.employmentType || null,
        employmentStatus: 'Active',
        licenseNumber:    d.licenseNumber || null,
        specialty:        d.specialty || null,
        qualification:    d.qualification || null,
        institution:      d.medicalSchool || null,
        yearsExperience:  d.yearsExperience || null,
        roleDetails:      asJson(d.subSpecialty ? { subSpecialty: d.subSpecialty } : {}),
        createdAt:        d.createdAt || now(),
        updatedAt:        now(),
      });
      alreadyHasProfile.add(d.userId);
    }

    // ---- Lab techs ----
    const [labTechs] = await queryInterface.sequelize.query(`
      SELECT lp.*, u.id AS userId
      FROM LabTechProfiles lp
      JOIN Users u ON u.id = lp.UserId
    `);

    for (const l of labTechs) {
      if (alreadyHasProfile.has(l.userId)) continue;
      rows.push({
        UserId:           l.userId,
        position:         'Lab Technician',
        department:       'Laboratory',
        shift:            l.shift || null,
        startDate:        l.startDate || null,
        employmentStatus: 'Active',
        licenseNumber:    l.certificationNumber || null,
        specialty:        l.specialization || null,
        qualification:    l.qualification || null,
        institution:      l.institution || null,
        yearsExperience:  l.yearsExperience || null,
        roleDetails:      asJson({}),
        createdAt:        l.createdAt || now(),
        updatedAt:        now(),
      });
      alreadyHasProfile.add(l.userId);
    }

    if (rows.length) await queryInterface.bulkInsert('StaffProfiles', rows);

    // Existing staff/nurse rows predate these columns entirely.
    await queryInterface.sequelize.query(`
      UPDATE StaffProfiles
      SET employmentStatus = 'Active'
      WHERE employmentStatus IS NULL
    `);
    await queryInterface.sequelize.query(`
      UPDATE StaffProfiles
      SET roleDetails = '{}'
      WHERE roleDetails IS NULL
    `);
  },

  // Removes only the rows this migration created — identified by the users who
  // still have a source profile row. Rows belonging to staff and nurses, which
  // existed before this migration, are left alone.
  async down(queryInterface) {
    const required = ['StaffProfiles', 'DoctorProfiles', 'LabTechProfiles'];
    if (!(await tablesExist(queryInterface, required))) return;

    // MySQL refuses to read the target table inside a subquery of a DELETE on
    // that same table, so the IDs are collected first.
    const [rows] = await queryInterface.sequelize.query(`
      SELECT UserId FROM DoctorProfiles
      UNION
      SELECT UserId FROM LabTechProfiles
    `);

    const userIds = rows.map((r) => r.UserId).filter((id) => id != null);
    if (!userIds.length) return;

    await queryInterface.sequelize.query(
      'DELETE FROM StaffProfiles WHERE UserId IN (:userIds)',
      { replacements: { userIds } }
    );
  },
};
