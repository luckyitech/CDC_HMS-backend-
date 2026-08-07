'use strict';

/**
 * Creates PatientDiagnoses — the tracked per-patient diagnosis list.
 * Clinical record: rows are never hard-deleted; "removing" sets status='resolved'.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => String(t).toLowerCase()).includes('patientdiagnoses')) return;

    await queryInterface.createTable('PatientDiagnoses', {
      id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      diagnosis: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.ENUM('active', 'resolved'), allowNull: false, defaultValue: 'active' },
      diagnosedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      resolvedAt: { type: Sequelize.DATE, allowNull: true, defaultValue: null },
      PatientId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Patients', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      addedById: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      resolvedById: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('PatientDiagnoses', ['PatientId', 'status']);
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => String(t).toLowerCase()).includes('patientdiagnoses')) {
      await queryInterface.dropTable('PatientDiagnoses');
    }
  },
};
