'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('EquipmentAuditLogs')) return;

    await queryInterface.createTable('EquipmentAuditLogs', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      PatientId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      equipmentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      action: {
        type: Sequelize.ENUM('add', 'edit', 'replace'),
        allowNull: false,
      },
      deviceType: {
        type: Sequelize.ENUM('pump', 'transmitter'),
        allowNull: false,
      },
      field: {
        type: Sequelize.STRING,
        defaultValue: null,
      },
      oldValue: {
        type: Sequelize.TEXT,
        defaultValue: null,
      },
      newValue: {
        type: Sequelize.TEXT,
        defaultValue: null,
      },
      summary: {
        type: Sequelize.TEXT,
        defaultValue: null,
      },
      changedBy: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      changedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('EquipmentAuditLogs');
  },
};
