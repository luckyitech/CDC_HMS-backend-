'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Notifications')) return;

    await queryInterface.createTable('Notifications', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'document_uploaded',
      },
      patientName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      patientUhid: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      documentName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      documentCategory: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      uploadedBy: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      assignedDoctorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      isRead: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

    await queryInterface.addIndex('Notifications', ['assignedDoctorId', 'isRead'], {
      name: 'idx_notifications_doctor_read',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Notifications');
  },
};
