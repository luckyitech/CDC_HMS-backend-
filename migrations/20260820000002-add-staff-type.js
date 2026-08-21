'use strict';

// Splits the 'staff' bin into clinical and non-clinical.
//
// `role` says which portal someone lands in; it does not say whether they touch
// patients. 'staff' held receptionists, administration and nurses together, so
// all of them could read consultation notes and treatment plans and record
// vitals. This column is the axis that separates them.
//
// DEPLOY-DAY BEHAVIOUR: everyone becomes clinical, so nobody loses anything
// when this runs. That direction is deliberate — in production five of the
// eight staff accounts are nurses, so defaulting to non-clinical would disable
// most of the clinical workforce the moment the column landed. Access is
// removed by classifying people deliberately, in the migration below and then
// through the Permissions tab, never by a default.
//
// The addColumn is nullable first, then backfilled, then made NOT NULL. Adding
// a NOT NULL column with a default to a populated table failed on this project
// before (deniedPermissions, 'CONSTRAINT Users.deniedPermissions failed'), so
// the three-step is not superstition.

const TABLE = 'Users';

const resolveTable = async (queryInterface, name) => {
  const tables = await queryInterface.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

const hasColumn = async (queryInterface, table, column) => {
  const described = await queryInterface.describeTable(table);
  return Object.keys(described).some((c) => c.toLowerCase() === column.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    if (!(await hasColumn(queryInterface, table, 'staffType'))) {
      await queryInterface.addColumn(table, 'staffType', {
        type: Sequelize.ENUM('clinical', 'non_clinical'),
        allowNull: true,
      });

      await queryInterface.sequelize.query(
        `UPDATE \`${table}\` SET staffType = 'clinical' WHERE staffType IS NULL`
      );

      await queryInterface.changeColumn(table, 'staffType', {
        type: Sequelize.ENUM('clinical', 'non_clinical'),
        allowNull: false,
        defaultValue: 'clinical',
      });
    }

    // ------------------------------------------------------------------
    // Classify the accounts that are NOT clinical.
    //
    // Matched on the StaffProfile position rather than on a list of employee
    // IDs, so this is correct on any deployment rather than only on the one it
    // was written against. A clinic with no receptionists classifies nobody,
    // which is the right outcome, not a silent failure.
    //
    // Deliberately conservative: it names the positions that are certainly
    // non-clinical and leaves everything else clinical. Getting this wrong in
    // the clinical direction leaves someone with access they had yesterday;
    // getting it wrong in the other direction stops a nurse working.
    // ------------------------------------------------------------------
    const profiles = await resolveTable(queryInterface, 'StaffProfiles');
    if (profiles) {
      await queryInterface.sequelize.query(`
        UPDATE \`${table}\` u
        JOIN \`${profiles}\` sp ON sp.UserId = u.id
        SET u.staffType = 'non_clinical'
        WHERE u.role = 'staff'
          AND sp.deletedAt IS NULL
          AND (
            LOWER(sp.position) LIKE '%receptionist%'
            OR LOWER(sp.position) LIKE '%front desk%'
            OR LOWER(sp.position) LIKE '%account%'
            OR LOWER(sp.position) LIKE '%cashier%'
            OR LOWER(sp.position) LIKE '%records%'
            OR LOWER(sp.position) = 'admin'
            OR LOWER(sp.position) = 'administrator'
          )
      `);
    }

    // ------------------------------------------------------------------
    // Give the nurses the inpatient ward.
    //
    // portal.inpatient belonged to role 'nurse', and NO account holds that role
    // — every nurse in production is role 'staff'. So no nurse could open the
    // ward, which is a plausible reason the whole inpatient module has never
    // been used. This is the one place the migration ADDS access.
    //
    // Written as an explicit grant rather than folded into the clinical bundle
    // because staffType is independent of role: a clinical default would also
    // hand the ward to the lab technician, who has no business there.
    //
    // The CASE rather than COALESCE(NULLIF(...)) is portability, not taste:
    // MariaDB has no real JSON type (it is an alias for LONGTEXT) and rejects
    // CAST('null' AS JSON), which MySQL accepts. JSON_TYPE works on both, and
    // also catches a column holding the literal string 'null' — which this
    // schema does produce, since permissions is nullable and older rows carry
    // it. Appending to that would corrupt the value rather than fail loudly.
    //
    // JSON_ARRAY_APPEND with a JSON_CONTAINS guard so re-running is a no-op,
    // and so an account that already holds the grant is not given it twice.
    // ------------------------------------------------------------------
    if (profiles) {
      await queryInterface.sequelize.query(`
        UPDATE \`${table}\` u
        JOIN \`${profiles}\` sp ON sp.UserId = u.id
        SET u.permissions = JSON_ARRAY_APPEND(
              CASE WHEN u.permissions IS NULL
                     OR JSON_TYPE(u.permissions) <> 'ARRAY'
                   THEN JSON_ARRAY() ELSE u.permissions END,
              '$', 'portal.inpatient')
        WHERE u.role = 'staff'
          AND sp.deletedAt IS NULL
          AND LOWER(sp.position) LIKE '%nurse%'
          AND NOT JSON_CONTAINS(
                CASE WHEN u.permissions IS NULL
                       OR JSON_TYPE(u.permissions) <> 'ARRAY'
                     THEN JSON_ARRAY() ELSE u.permissions END,
                '"portal.inpatient"')
      `);
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    // The inpatient grants are deliberately NOT removed. They corrected an
    // access gap that predates this branch — nurses could never open the ward —
    // and rolling the column back is not a reason to lock them out again.

    if (await hasColumn(queryInterface, table, 'staffType')) {
      await queryInterface.removeColumn(table, 'staffType');
      // MySQL keeps the ENUM type behind the column; Postgres needs it dropped.
      if (queryInterface.sequelize.getDialect() === 'postgres') {
        await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Users_staffType"');
      }
    }
  },
};
