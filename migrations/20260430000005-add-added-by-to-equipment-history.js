'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('EquipmentHistories');

    if (!table.addedBy) {
      await queryInterface.addColumn('EquipmentHistories', 'addedBy', {
        type: Sequelize.INTEGER,
        defaultValue: null,
      });
    }
    if (!table.addedDate) {
      await queryInterface.addColumn('EquipmentHistories', 'addedDate', {
        type: Sequelize.DATE,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('EquipmentHistories', 'addedBy');
    await queryInterface.removeColumn('EquipmentHistories', 'addedDate');
  },
};
