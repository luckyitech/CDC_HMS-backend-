'use strict';

// Scheduled password rotation — records when a user last set their OWN password.
//
// Deliberately left NULL for every existing row rather than backfilled to
// createdAt. NULL means "this account has never had a password the user chose
// themselves" — which is exactly true of an admin-created account still on its
// emailed temp password, and is treated as expired. So the first login after
// an admin enables rotation lands every staff member on the change-password
// screen, which is the intended rollout.
//
// Guarded with describeTable; working down().

const TABLE = 'Users';
const COLUMN = 'passwordChangedAt';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) return;

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
