'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDescription = await queryInterface.describeTable('Queues');

    if (!tableDescription.finalCharges) {
      await queryInterface.addColumn('Queues', 'finalCharges', {
        type: Sequelize.JSON,
        defaultValue: null,
      });
    }
    if (!tableDescription.finalProcedures) {
      await queryInterface.addColumn('Queues', 'finalProcedures', {
        type: Sequelize.JSON,
        defaultValue: null,
      });
    }
    if (!tableDescription.dischargeComment) {
      await queryInterface.addColumn('Queues', 'dischargeComment', {
        type: Sequelize.TEXT,
        defaultValue: null,
      });
    }
    if (!tableDescription.dischargedBy) {
      await queryInterface.addColumn('Queues', 'dischargedBy', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Queues', 'finalCharges');
    await queryInterface.removeColumn('Queues', 'finalProcedures');
    await queryInterface.removeColumn('Queues', 'dischargeComment');
    await queryInterface.removeColumn('Queues', 'dischargedBy');
  },
};
