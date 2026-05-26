'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('Patients');
    if (!tableDesc.summaryUpdatedBy) {
      await queryInterface.addColumn('Patients', 'summaryUpdatedBy', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
    if (!tableDesc.summaryUpdatedAt) {
      await queryInterface.addColumn('Patients', 'summaryUpdatedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'summaryUpdatedBy');
    await queryInterface.removeColumn('Patients', 'summaryUpdatedAt');
  },
};
