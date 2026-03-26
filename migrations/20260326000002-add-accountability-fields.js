'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const patients = await queryInterface.describeTable('Patients');
    if (!patients.registeredBy) {
      await queryInterface.addColumn('Patients', 'registeredBy', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }

    const queues = await queryInterface.describeTable('Queues');
    if (!queues.addedBy) {
      await queryInterface.addColumn('Queues', 'addedBy', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!queues.triagedBy) {
      await queryInterface.addColumn('Queues', 'triagedBy', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'registeredBy');
    await queryInterface.removeColumn('Queues', 'addedBy');
    await queryInterface.removeColumn('Queues', 'triagedBy');
  },
};
