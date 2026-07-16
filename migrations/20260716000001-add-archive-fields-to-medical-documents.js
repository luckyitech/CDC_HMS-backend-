'use strict';

// Admin archive ("recycle bin") fields for wrongly uploaded documents.
// Archived documents are hidden from every view but never deleted —
// the file and record are always kept and can be restored.
// Distinct from the existing status 'Archived', which only hides a
// document from the patient portal.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('medicaldocuments', 'isArchived', {
      type:         Sequelize.BOOLEAN,
      allowNull:    false,
      defaultValue: false,
    });
    await queryInterface.addColumn('medicaldocuments', 'archivedBy', {
      type:         Sequelize.STRING,
      allowNull:    true,
      defaultValue: null,
    });
    await queryInterface.addColumn('medicaldocuments', 'archivedAt', {
      type:         Sequelize.DATE,
      allowNull:    true,
      defaultValue: null,
    });
    await queryInterface.addColumn('medicaldocuments', 'archiveReason', {
      type:         Sequelize.TEXT,
      allowNull:    true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('medicaldocuments', 'isArchived');
    await queryInterface.removeColumn('medicaldocuments', 'archivedBy');
    await queryInterface.removeColumn('medicaldocuments', 'archivedAt');
    await queryInterface.removeColumn('medicaldocuments', 'archiveReason');
  },
};
