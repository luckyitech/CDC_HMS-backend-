'use strict';

module.exports = {
  async up(queryInterface) {
    const table = await queryInterface.describeTable('Patients');
    if (table.age) {
      await queryInterface.removeColumn('Patients', 'age');
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Patients', 'age', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },
};
