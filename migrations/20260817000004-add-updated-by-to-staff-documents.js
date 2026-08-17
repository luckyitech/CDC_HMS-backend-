'use strict';

// StaffDocuments has an update endpoint that can change an HR record's category,
// visibility, expiry date and notes — with no record of who made the change.
// Adds updatedById, matching the table's own uploadedById / archivedById naming.
//
// updatedAt already exists (model timestamps), so only the actor is missing.
//
// Guarded and idempotent: safe on a database in any state.

const TABLE = 'StaffDocuments';

const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;
    const cols = await queryInterface.describeTable(TABLE);
    if (cols.updatedById) return;

    await queryInterface.addColumn(TABLE, 'updatedById', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      references: { model: 'Users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    const cols = await queryInterface.describeTable(TABLE);
    if (cols.updatedById) await queryInterface.removeColumn(TABLE, 'updatedById');
  },
};
