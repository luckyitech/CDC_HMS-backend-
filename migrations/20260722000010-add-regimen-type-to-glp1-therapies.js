'use strict';

/**
 * Adds Glp1Therapies.regimenType — 'standard' or 'custom'.
 *
 * 'standard' means the clinic's four-weekly titration ladder from the formulary,
 * with the usual 4/8/12/24/36/52 monitoring weeks. 'custom' means the doctor
 * built the ladder for this patient: their own doses, their own escalation
 * interval, and a start week that may not be zero because the patient
 * transferred in mid-therapy.
 *
 * Recording which was chosen matters clinically. A ladder starting at week 16
 * with no titration history is either a data-entry error or a transfer-in
 * patient, and only this column tells them apart. It also makes the two
 * populations separable in reporting.
 *
 * Additive and nullable-safe: every existing row gets 'standard', which is what
 * they all are.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // showAllTables() may return { tableName } objects rather than strings;
    // String() on those gives '[object Object]', so map explicitly.
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('glp1therapies')) {
      console.log('Glp1Therapies not found — skipping');
      return;
    }

    // Guard on the column, not just the table: a stray sync() can create the
    // table from the model without this migration having run.
    const columns = await queryInterface.describeTable('Glp1Therapies');
    if (columns.regimenType) {
      console.log('Glp1Therapies.regimenType already exists — skipping');
      return;
    }

    await queryInterface.addColumn('Glp1Therapies', 'regimenType', {
      type: Sequelize.ENUM('standard', 'custom'),
      allowNull: false,
      defaultValue: 'standard',
    });
    console.log('Added Glp1Therapies.regimenType');
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map(t => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('glp1therapies')) return;

    const columns = await queryInterface.describeTable('Glp1Therapies');
    if (!columns.regimenType) return;

    await queryInterface.removeColumn('Glp1Therapies', 'regimenType');
    // MySQL leaves the ENUM type behind on some versions; harmless if absent
    await queryInterface.sequelize
      .query('DROP TYPE IF EXISTS "enum_Glp1Therapies_regimenType"')
      .catch(() => {});
  },
};
