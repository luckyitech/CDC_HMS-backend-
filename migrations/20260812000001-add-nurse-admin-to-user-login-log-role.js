'use strict';

// UserLoginLogs.role only allowed doctor / staff / lab, so a nurse or admin
// login could never be stored. activityLogService skipped those two roles
// entirely — and had it tried, the insert would have been rejected and
// swallowed by the fire-and-forget .catch().
//
// Widening the enum has to come first; the service change is pointless without
// it. Guarded and re-runnable.

const TABLE = 'UserLoginLogs';
const COLUMN = 'role';

const OLD_ROLES = ['doctor', 'staff', 'lab'];
const NEW_ROLES = ['doctor', 'staff', 'lab', 'nurse', 'admin'];

const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.ENUM(...NEW_ROLES),
      allowNull: false,
    });
  },

  // Narrowing again would fail on any row already storing 'nurse' or 'admin',
  // so those are removed first. They are login audit rows, not clinical data —
  // losing them on a deliberate rollback is acceptable, and leaving the
  // migration un-reversible is not.
  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    await queryInterface.sequelize.query(
      `DELETE FROM ${TABLE} WHERE ${COLUMN} NOT IN (:roles)`,
      { replacements: { roles: OLD_ROLES } }
    );

    await queryInterface.changeColumn(TABLE, COLUMN, {
      type: Sequelize.ENUM(...OLD_ROLES),
      allowNull: false,
    });
  },
};
