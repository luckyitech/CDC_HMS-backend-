'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDescription = await queryInterface.describeTable('UserEditLogs');
    if (!tableDescription.targetUserId) {
      await queryInterface.addColumn('UserEditLogs', 'targetUserId', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        after: 'id',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('UserEditLogs', 'targetUserId');
  },
};
