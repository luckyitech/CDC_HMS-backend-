'use strict';

// Repairs the NursingNotes table. An earlier build created it WITHOUT its
// PatientId / authorId foreign-key columns (the create migration's "skip if the
// table already exists" guard then meant the corrected version never rebuilt
// it), so every query failed with: Unknown column 'NursingNote.PatientId'.
//
// This adds the two columns only when they're missing — guarded and idempotent,
// so it's safe to run on any database whatever state its NursingNotes is in.

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

    if (!cols.PatientId) {
      await queryInterface.addColumn(TABLE, 'PatientId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Patients', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      });
    }

    if (!cols.authorId) {
      await queryInterface.addColumn(TABLE, 'authorId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    const cols = await queryInterface.describeTable(TABLE);
    if (cols.authorId) await queryInterface.removeColumn(TABLE, 'authorId');
    if (cols.PatientId) await queryInterface.removeColumn(TABLE, 'PatientId');
  },
};
