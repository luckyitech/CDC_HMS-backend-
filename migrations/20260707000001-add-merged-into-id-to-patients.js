'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Patients', 'mergedIntoId', {
      type:       Sequelize.INTEGER,
      allowNull:  true,
      defaultValue: null,
      references: { model: 'Patients', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'mergedIntoId');
  },
};
