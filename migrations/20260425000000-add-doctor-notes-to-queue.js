'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = await queryInterface.describeTable('Queues');
    if (!existing.doctorNotes) {
      await queryInterface.addColumn('Queues', 'doctorNotes', {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
        after: 'selectedProcedures',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Queues', 'doctorNotes');
  },
};
