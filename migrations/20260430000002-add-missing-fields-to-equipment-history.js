'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('EquipmentHistories');

    if (!table.type) {
      await queryInterface.addColumn('EquipmentHistories', 'type', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!table.careLinkCountry) {
      await queryInterface.addColumn('EquipmentHistories', 'careLinkCountry', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!table.careLinkEmail) {
      await queryInterface.addColumn('EquipmentHistories', 'careLinkEmail', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!table.careLinkPassword) {
      await queryInterface.addColumn('EquipmentHistories', 'careLinkPassword', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('EquipmentHistories', 'type');
    await queryInterface.removeColumn('EquipmentHistories', 'careLinkCountry');
    await queryInterface.removeColumn('EquipmentHistories', 'careLinkEmail');
    await queryInterface.removeColumn('EquipmentHistories', 'careLinkPassword');
  },
};
