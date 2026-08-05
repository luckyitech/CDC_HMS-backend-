'use strict';

/**
 * Per-user permissions, replacing one-off boolean columns.
 *
 * canManageStock was a dedicated column with its own middleware. A second
 * capability (admin portal access) would have meant a second column and a
 * second middleware, and a third would have meant a third — so capabilities
 * move into one JSON array checked by one generic middleware, and a new one
 * costs a string rather than a schema change.
 *
 * Existing canManageStock grants are backfilled to 'stock.manage', so nobody
 * loses access at deploy time. The column is deliberately LEFT IN PLACE: the
 * API still reports canManageStock (derived) so the frontend needs no change,
 * and keeping it means this migration is reversible without data loss. Drop it
 * in a later migration once nothing reads it.
 *
 * Idempotent, with a working down().
 */

const TABLE = 'Users';
const COLUMN = 'permissions';

const tableExists = async (queryInterface) => {
  const tables = (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
  return tables.includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) {
      console.log(`${TABLE} does not exist yet — skipping`);
      return;
    }

    const desc = await queryInterface.describeTable(TABLE);
    if (desc[COLUMN]) {
      console.log(`${TABLE}.${COLUMN} already exists — skipping`);
      return;
    }

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.JSON,
      allowNull: false,
      defaultValue: [],
    });

    // Backfill from the boolean it replaces. Admins are skipped on purpose:
    // a real admin holds every permission implicitly (see
    // constants/permissions.js), so storing a list on their row would be a
    // second copy of the same fact, free to drift.
    if (desc.canManageStock) {
      const [affected] = await queryInterface.sequelize.query(
        `UPDATE \`${TABLE}\`
            SET \`${COLUMN}\` = CAST('["stock.manage"]' AS JSON)
          WHERE canManageStock = 1
            AND role <> 'admin'`
      );
      console.log(`Backfilled stock.manage for ${affected?.affectedRows ?? 0} user(s).`);
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    const desc = await queryInterface.describeTable(TABLE);
    if (!desc[COLUMN]) return;

    // canManageStock was never dropped, so rolling back loses only grants made
    // after this migration ran — and those are re-grantable from the UI.
    await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
