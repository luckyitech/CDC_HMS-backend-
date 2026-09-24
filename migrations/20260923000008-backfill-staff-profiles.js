'use strict';

// HR Suite / staff directory — backfill a StaffProfile for every internal-staff
// user that has none.
//
// StaffProfiles is the single profile table for every cadre now, and GET
// /api/staff (the directory) reads only it. The August consolidation emptied
// the old DoctorProfiles/LabTechProfiles tables but never created StaffProfiles
// rows for the users that lived in them, so those people are invisible in the
// directory. This inserts a profile SHELL (employeeId + role-appropriate blanks)
// for each such user — doctor, nurse, lab, staff and admin — so they all appear
// the moment this deploys. Names, licences, departments are edited in the file.
//
// Only INSERTS. Never touches Users, never edits or deletes an existing profile.
// Each inserted row is marked in roleDetails (a JSON column the app does not use)
// so the down() removes exactly what this created and nothing real.

const STAFF_ROLES = ['doctor', 'nurse', 'lab', 'staff', 'admin'];
const MARKER = '20260923000008';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasColumn = async (qi, table, col) => {
  const d = await qi.describeTable(table);
  return Object.keys(d).some((c) => c.toLowerCase() === col.toLowerCase());
};

// Next EMP### number, numeric (not string) max, matching utils/generateId.js.
const nextEmpNumber = async (qi, Sequelize) => {
  const [rows] = await qi.sequelize.query(
    "SELECT employeeId FROM StaffProfiles WHERE employeeId REGEXP '^EMP[0-9]+$'"
  );
  const nums = rows
    .map((r) => parseInt(String(r.employeeId).replace('EMP', ''), 10))
    .filter((n) => !Number.isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const staffTable = await resolveTable(queryInterface, 'StaffProfiles');
    const usersTable = await resolveTable(queryInterface, 'Users');
    if (!staffTable || !usersTable) return;

    // roleDetails is where the marker goes — bail rather than guess if it's absent.
    if (!(await hasColumn(queryInterface, staffTable, 'roleDetails'))) return;
    if (!(await hasColumn(queryInterface, staffTable, 'employeeId'))) return;

    const roleList = STAFF_ROLES.map((r) => `'${r}'`).join(',');
    const [missing] = await queryInterface.sequelize.query(
      `SELECT u.id AS userId, u.role AS role
         FROM ${usersTable} u
         LEFT JOIN ${staffTable} sp ON sp.UserId = u.id
        WHERE u.role IN (${roleList}) AND sp.id IS NULL
        ORDER BY u.id ASC`
    );
    if (!missing.length) return;

    let n = await nextEmpNumber(queryInterface, Sequelize);
    const now = new Date();

    const rows = missing.map((m) => {
      const employeeId = 'EMP' + String(n++).padStart(3, '0');
      return {
        UserId:           m.userId,
        employeeId,
        employmentStatus: 'Active',
        roleDetails:      JSON.stringify({ backfilledBy: MARKER }),
        createdAt:        now,
        updatedAt:        now,
      };
    });

    await queryInterface.bulkInsert(staffTable, rows);
  },

  async down(queryInterface) {
    const staffTable = await resolveTable(queryInterface, 'StaffProfiles');
    if (!staffTable) return;
    if (!(await hasColumn(queryInterface, staffTable, 'roleDetails'))) return;

    // Remove only the shells this migration inserted — identified by the marker
    // it wrote into roleDetails. Real profiles never carry it.
    await queryInterface.sequelize.query(
      `DELETE FROM ${staffTable} WHERE roleDetails LIKE '%${MARKER}%'`
    );
  },
};
