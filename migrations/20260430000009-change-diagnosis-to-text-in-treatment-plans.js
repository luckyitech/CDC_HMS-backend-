'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('TreatmentPlans', 'diagnosis', {
      type:      Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('TreatmentPlans', 'diagnosis', {
      type:      Sequelize.STRING,
      allowNull: true,
    });
  },
};
