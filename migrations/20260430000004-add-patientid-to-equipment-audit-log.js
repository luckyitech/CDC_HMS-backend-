'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('EquipmentAuditLogs');

    if (!table.PatientId) {
      await queryInterface.addColumn('EquipmentAuditLogs', 'PatientId', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('EquipmentAuditLogs', 'PatientId');
  },
};
