'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Queues', 'consultationSessions', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
      after: 'consultationEndTime',
      comment: 'Array of { doctorId, doctorName, startTime, endTime } — one entry per doctor who consulted this patient. Supports accurate per-doctor timing even when referrals occur.',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Queues', 'consultationSessions');
  },
};
