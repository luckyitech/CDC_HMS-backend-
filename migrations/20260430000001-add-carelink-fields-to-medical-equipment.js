'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('MedicalEquipments');

    if (!table.careLinkCountry) {
      await queryInterface.addColumn('MedicalEquipments', 'careLinkCountry', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!table.careLinkEmail) {
      await queryInterface.addColumn('MedicalEquipments', 'careLinkEmail', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!table.careLinkPassword) {
      await queryInterface.addColumn('MedicalEquipments', 'careLinkPassword', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('MedicalEquipments', 'careLinkCountry');
    await queryInterface.removeColumn('MedicalEquipments', 'careLinkEmail');
    await queryInterface.removeColumn('MedicalEquipments', 'careLinkPassword');
  },
};
