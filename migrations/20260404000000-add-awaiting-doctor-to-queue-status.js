'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Waiting',
        'In Triage',
        'Awaiting Doctor',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Waiting',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Waiting',
        'In Triage',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Waiting',
    });
  },
};
