'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('CareLinkPartners');

    if (!table.isActive) {
      await queryInterface.addColumn('CareLinkPartners', 'isActive', {
        type:         Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull:    false,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('CareLinkPartners', 'isActive');
  },
};
