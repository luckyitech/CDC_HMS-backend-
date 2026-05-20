'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const apptCols = await queryInterface.describeTable('Appointments');

    if (!apptCols.bookedBy) {
      await queryInterface.addColumn('Appointments', 'bookedBy', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
        after: 'bookedAt',
      });
    }
    if (!apptCols.bookedByRole) {
      await queryInterface.addColumn('Appointments', 'bookedByRole', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
        after: 'bookedBy',
      });
    }
    if (!apptCols.bookedById) {
      await queryInterface.addColumn('Appointments', 'bookedById', {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
        after: 'bookedByRole',
      });
    }

    const blockCols = await queryInterface.describeTable('DoctorBlocks');
    if (!blockCols.blockedBy) {
      await queryInterface.addColumn('DoctorBlocks', 'blockedBy', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
    if (!blockCols.reason) {
      await queryInterface.addColumn('DoctorBlocks', 'reason', {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const apptCols  = await queryInterface.describeTable('Appointments');
    const blockCols = await queryInterface.describeTable('DoctorBlocks');

    if (apptCols.bookedBy)     await queryInterface.removeColumn('Appointments', 'bookedBy');
    if (apptCols.bookedByRole) await queryInterface.removeColumn('Appointments', 'bookedByRole');
    if (apptCols.bookedById)   await queryInterface.removeColumn('Appointments', 'bookedById');
    if (blockCols.blockedBy)   await queryInterface.removeColumn('DoctorBlocks', 'blockedBy');
    if (blockCols.reason)      await queryInterface.removeColumn('DoctorBlocks', 'reason');
  },
};
