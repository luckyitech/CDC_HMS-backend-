'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Patients');
    if (!table.registeredByRole) {
      await queryInterface.addColumn('Patients', 'registeredByRole', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'registeredByRole');
  },
};
