'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('DoctorBlocks')) return;

    await queryInterface.createTable('DoctorBlocks', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      doctorId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },
      timeSlot: {
        type: Sequelize.STRING,
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

    await queryInterface.addIndex('DoctorBlocks', ['doctorId', 'date', 'timeSlot'], {
      unique: true,
      name: 'unique_doctor_date_slot_block',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('DoctorBlocks');
  },
};
