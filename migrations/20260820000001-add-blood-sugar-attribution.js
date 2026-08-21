'use strict';

// Records WHO entered a blood-sugar reading, and in what capacity.
//
// Until now only a patient could write one, so there was nothing to record.
// Clinical staff can now log the reading taken when a patient comes into
// clinic, and a home glucometer reading is not the same evidence as a clinic
// measurement — a chart that cannot tell them apart misleads whoever reads it.
//
// Both columns are nullable and NOT backfilled. Every existing row predates
// this and its author is not recoverable; a null honestly means "recorded
// before this was tracked". Backfilling them all as 'patient' would turn a
// guess into a stored fact, and would be wrong for every reading a doctor or
// nurse entered through some other path.

const addIfMissing = async (queryInterface, table, column, spec) => {
  const tables = await queryInterface.showAllTables();
  const real = tables.find((t) => String(t).toLowerCase() === table.toLowerCase());
  if (!real) return;                       // table not built yet — nothing to alter
  const described = await queryInterface.describeTable(real);
  const has = Object.keys(described).some((c) => c.toLowerCase() === column.toLowerCase());
  if (has) return;                         // already applied
  await queryInterface.addColumn(real, column, spec);
};

const removeIfPresent = async (queryInterface, table, column) => {
  const tables = await queryInterface.showAllTables();
  const real = tables.find((t) => String(t).toLowerCase() === table.toLowerCase());
  if (!real) return;
  const described = await queryInterface.describeTable(real);
  const has = Object.keys(described).some((c) => c.toLowerCase() === column.toLowerCase());
  if (!has) return;
  await queryInterface.removeColumn(real, column);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    await addIfMissing(queryInterface, 'BloodSugarReadings', 'recordedById', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addIfMissing(queryInterface, 'BloodSugarReadings', 'recordedByRole', {
      type: Sequelize.ENUM('patient', 'clinic'),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeIfPresent(queryInterface, 'BloodSugarReadings', 'recordedByRole');
    await removeIfPresent(queryInterface, 'BloodSugarReadings', 'recordedById');
  },
};
