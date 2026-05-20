'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('Appointments');

    if (!cols.cancelledBy) {
      await queryInterface.addColumn('Appointments', 'cancelledBy', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
    if (!cols.cancelledByRole) {
      await queryInterface.addColumn('Appointments', 'cancelledByRole', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
    if (!cols.cancelledAt) {
      await queryInterface.addColumn('Appointments', 'cancelledAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const cols = await queryInterface.describeTable('Appointments');
    if (cols.cancelledBy)     await queryInterface.removeColumn('Appointments', 'cancelledBy');
    if (cols.cancelledByRole) await queryInterface.removeColumn('Appointments', 'cancelledByRole');
    if (cols.cancelledAt)     await queryInterface.removeColumn('Appointments', 'cancelledAt');
  },
};
