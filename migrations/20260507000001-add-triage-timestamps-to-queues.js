'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Queues', 'triageStartTime', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
      after: 'reason',
    });

    await queryInterface.addColumn('Queues', 'triageEndTime', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
      after: 'triageStartTime',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Queues', 'triageEndTime');
    await queryInterface.removeColumn('Queues', 'triageStartTime');
  },
};
