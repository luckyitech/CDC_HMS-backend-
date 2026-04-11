'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // First expand the ENUM to include both old and new values so no existing
    // records become invalid during the transition
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Waiting',
        'Awaiting Triage',
        'In Triage',
        'Awaiting Doctor',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Awaiting Triage',
    });

    // Migrate existing 'Waiting' records to 'Awaiting Triage'
    await queryInterface.sequelize.query(
      `UPDATE Queues SET status = 'Awaiting Triage' WHERE status = 'Waiting'`
    );

    // Now remove the old 'Waiting' value from the ENUM
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Awaiting Triage',
        'In Triage',
        'Awaiting Doctor',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Awaiting Triage',
    });
  },

  async down(queryInterface, Sequelize) {
    // Expand ENUM to include both during rollback
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Waiting',
        'Awaiting Triage',
        'In Triage',
        'Awaiting Doctor',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Waiting',
    });

    // Revert 'Awaiting Triage' back to 'Waiting'
    await queryInterface.sequelize.query(
      `UPDATE Queues SET status = 'Waiting' WHERE status = 'Awaiting Triage'`
    );

    // Remove 'Awaiting Triage' from the ENUM
    await queryInterface.changeColumn('Queues', 'status', {
      type: Sequelize.ENUM(
        'Waiting',
        'In Triage',
        'Awaiting Doctor',
        'With Doctor',
        'Pending Billing',
        'Completed',
        'Removed'
      ),
      allowNull: false,
      defaultValue: 'Waiting',
    });
  },
};
