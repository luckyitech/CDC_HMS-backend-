'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('CareLinkPartners');

    if (!table.PatientId) {
      await queryInterface.addColumn('CareLinkPartners', 'PatientId', {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Patients', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('CareLinkPartners', 'PatientId');
  },
};
