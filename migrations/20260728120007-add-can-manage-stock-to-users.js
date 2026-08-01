'use strict';

// Stock module — minimal per-user permission: admin grants stock access to
// individual staff/doctors via a single flag. Read from the DB inside
// authorizeStock (not the JWT) so a grant takes effect without re-login.
// Guarded with describeTable; working down().

const TABLE = 'Users';
const COLUMN = 'canManageStock';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) return;

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
