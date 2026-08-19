'use strict';

// HMIS V4 — Machine inbox persistence: images stay listed in the inbox until
// a user explicitly removes them (inInbox=false). Attaching/saving does NOT
// clear them. Guarded.

const TABLE = 'UltrasoundImages';

const columnExists = async (qi, col) => {
  const [cols] = await qi.sequelize.query(`SHOW COLUMNS FROM ${TABLE} LIKE '${col}'`);
  return cols.length > 0;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, 'inInbox'))) {
      await queryInterface.addColumn(TABLE, 'inInbox', {
        type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, 'inInbox')) {
      await queryInterface.removeColumn(TABLE, 'inInbox');
    }
  },
};
