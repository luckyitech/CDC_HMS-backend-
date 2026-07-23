'use strict';

/**
 * Links a course to the one it replaced, so a switch between agents reads as a
 * switch rather than as two unrelated courses.
 *
 * A patient started on semaglutide and moved to tirzepatide keeps two rows —
 * each with its own dose ladder, reviews and history, because they are two
 * different drugs. This column is what lets the tool draw the switch and say
 * when it happened.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Glp1Therapies');

    if (!table.switchedFromTherapyId) {
      await queryInterface.addColumn('Glp1Therapies', 'switchedFromTherapyId', {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Glp1Therapies', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      });
    }

    if (!table.switchReason) {
      await queryInterface.addColumn('Glp1Therapies', 'switchReason', {
        type:      Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Glp1Therapies');

    if (table.switchReason) {
      await queryInterface.removeColumn('Glp1Therapies', 'switchReason');
    }
    if (table.switchedFromTherapyId) {
      await queryInterface.removeColumn('Glp1Therapies', 'switchedFromTherapyId');
    }
  },
};
