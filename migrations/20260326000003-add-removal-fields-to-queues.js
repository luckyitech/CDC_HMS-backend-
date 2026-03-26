'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Alter the ENUM to include 'Removed'
    await queryInterface.sequelize.query(
      "ALTER TABLE Queues MODIFY COLUMN status ENUM('Waiting', 'In Triage', 'With Doctor', 'Pending Billing', 'Completed', 'Removed') NOT NULL DEFAULT 'Waiting';"
    );

    const tableDescription = await queryInterface.describeTable('Queues');

    if (!tableDescription.removedBy) {
      await queryInterface.addColumn('Queues', 'removedBy', {
        type: Sequelize.STRING,
        defaultValue: null,
      });
    }
    if (!tableDescription.removalReason) {
      await queryInterface.addColumn('Queues', 'removalReason', {
        type: Sequelize.TEXT,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "ALTER TABLE Queues MODIFY COLUMN status ENUM('Waiting', 'In Triage', 'With Doctor', 'Pending Billing', 'Completed') NOT NULL DEFAULT 'Waiting';"
    );
    await queryInterface.removeColumn('Queues', 'removedBy');
    await queryInterface.removeColumn('Queues', 'removalReason');
  },
};
