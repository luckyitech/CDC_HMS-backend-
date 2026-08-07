'use strict';

/**
 * Adds Patients.chartMetrics — JSON array of chart metric keys the doctor
 * follows on the consultation summary panel (display preference only).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Patients');
    if (!table.chartMetrics) {
      await queryInterface.addColumn('Patients', 'chartMetrics', {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Patients');
    if (table.chartMetrics) {
      await queryInterface.removeColumn('Patients', 'chartMetrics');
    }
  },
};
