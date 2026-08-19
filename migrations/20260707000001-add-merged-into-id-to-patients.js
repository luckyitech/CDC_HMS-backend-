'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Guarded so this migration is safe to re-run, and safe on a database
    // built by sequelize.sync() — which is what server.js does on boot, so it
    // is the normal state of every dev machine here. Without this the migration
    // throws on an existing column and sequelize-cli stops, taking every later
    // migration with it.
    const addIfMissing = async (tableName, column, spec) => {
      // Resolve the real casing first. Some migrations name tables in lower
      // case, which MySQL on Windows accepts (lower_case_table_names=1) and a
      // case-sensitive host does not — so the guard has to be the tolerant part
      // rather than a second thing that only works on one platform.
      const actual = (await queryInterface.showAllTables())
        .map((t) => String(typeof t === 'string' ? t : t.tableName))
        .find((t) => t.toLowerCase() === String(tableName).toLowerCase());
      if (!actual) return;
      const desc = await queryInterface.describeTable(actual);
      if (desc[column]) return;
      await queryInterface.addColumn(actual, column, spec);
    };

    await addIfMissing('Patients', 'mergedIntoId', {
      type:       Sequelize.INTEGER,
      allowNull:  true,
      defaultValue: null,
      references: { model: 'Patients', key: 'id' },
      onUpdate:   'CASCADE',
      onDelete:   'SET NULL',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Patients', 'mergedIntoId');
  },
};
