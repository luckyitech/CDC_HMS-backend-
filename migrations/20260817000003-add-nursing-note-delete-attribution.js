'use strict';

// Nursing notes are soft deleted (status -> 'deleted'), but nothing recorded WHO
// removed a clinical note or WHEN — the row simply changed state. Adds the same
// delete attribution Glp1WeekNote already carries (deletedBy / deletedAt), which
// is the project's established naming for a soft-deleted clinical note.
//
// deletedBy is a real FK here, unlike Glp1WeekNote's plain integer: NursingNotes
// already constrains PatientId and authorId, so an unconstrained user column
// would be the odd one out in its own table. SET NULL on delete, matching
// authorId — losing the user must not delete the clinical record.
//
// Guarded and idempotent: safe on a database in any state.

const TABLE = 'NursingNotes';

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

    if (!cols.deletedBy) {
      await queryInterface.addColumn(TABLE, 'deletedBy', {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: null,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }

    if (!cols.deletedAt) {
      await queryInterface.addColumn(TABLE, 'deletedAt', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    const cols = await queryInterface.describeTable(TABLE);
    if (cols.deletedAt) await queryInterface.removeColumn(TABLE, 'deletedAt');
    if (cols.deletedBy) await queryInterface.removeColumn(TABLE, 'deletedBy');
  },
};
