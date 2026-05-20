'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('DoctorBlocks');
    if (!cols.reason) {
      await queryInterface.addColumn('DoctorBlocks', 'reason', {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const cols = await queryInterface.describeTable('DoctorBlocks');
    if (cols.reason) {
      await queryInterface.removeColumn('DoctorBlocks', 'reason');
    }
  },
};
