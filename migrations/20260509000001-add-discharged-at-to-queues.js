'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Queues', 'dischargedAt', {
      type:         Sequelize.DATE,
      allowNull:    true,
      defaultValue: null,
      after:        'dischargedBy',
      comment:      'Exact moment the patient exited the queue (Completed or Removed). Null on legacy records — use updatedAt as fallback for those.',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Queues', 'dischargedAt');
  },
};
