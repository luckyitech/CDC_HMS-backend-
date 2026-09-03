'use strict';

// Adds two columns to Queues so a visit knows where it is going:
//
//   destination — Outpatient | Inpatient | Radiology | Pharmacy
//   service     — free-form sub-type within a destination (e.g. Radiology ->
//                 'Neuropathy' / 'Ultrasound'). Nullable; only radiology uses
//                 it today.
//
// Every existing row is an outpatient clinic visit, so destination backfills to
// 'Outpatient' and nothing changes behaviour on deploy day. Following the
// project's safe three-step for a NOT NULL column on a populated table (add
// nullable -> backfill -> make NOT NULL with default); adding a NOT NULL+default
// column directly has failed on this DB before.
//
// Note: a walk-in Inpatient admission creates an Admission directly (never a
// Queue row), so in practice destination on a Queue row is Outpatient /
// Radiology / Pharmacy. 'Inpatient' is kept in the enum for completeness.

const TABLE = 'Queues';

const resolveTable = async (queryInterface, name) => {
  const tables = await queryInterface.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

const hasColumn = async (queryInterface, table, column) => {
  const described = await queryInterface.describeTable(table);
  return Object.keys(described).some((c) => c.toLowerCase() === column.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    if (!(await hasColumn(queryInterface, table, 'destination'))) {
      await queryInterface.addColumn(table, 'destination', {
        type: Sequelize.ENUM('Outpatient', 'Inpatient', 'Radiology', 'Pharmacy'),
        allowNull: true,
      });

      await queryInterface.sequelize.query(
        `UPDATE \`${table}\` SET destination = 'Outpatient' WHERE destination IS NULL`
      );

      await queryInterface.changeColumn(table, 'destination', {
        type: Sequelize.ENUM('Outpatient', 'Inpatient', 'Radiology', 'Pharmacy'),
        allowNull: false,
        defaultValue: 'Outpatient',
      });
    }

    if (!(await hasColumn(queryInterface, table, 'service'))) {
      await queryInterface.addColumn(table, 'service', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    if (await hasColumn(queryInterface, table, 'service')) {
      await queryInterface.removeColumn(table, 'service');
    }
    if (await hasColumn(queryInterface, table, 'destination')) {
      await queryInterface.removeColumn(table, 'destination');
      // MySQL leaves the ENUM type behind on the column drop; nothing else to clean.
    }
  },
};
