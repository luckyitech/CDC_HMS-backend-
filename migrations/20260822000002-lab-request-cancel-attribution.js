'use strict';

/**
 * Lab request cancel attribution — record WHO cancelled a lab request and WHEN,
 * mirroring the Appointment cancellation columns. Guarded + reversible.
 *   cancelledBy      display name of the clinician who cancelled
 *   cancelledByRole  their role ('doctor' | 'nurse' | …) for correct attribution
 *   cancelledAt      when it was cancelled
 *
 * A separate migration from 20260822000001 because that one has already run on
 * local dev; editing an applied migration would not re-run.
 */

const actualTableName = async (queryInterface, wanted) =>
  (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === String(wanted).toLowerCase()) || null;

const addColumnIfMissing = async (queryInterface, wanted, column, spec) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  if (desc[column]) return;
  await queryInterface.addColumn(actual, column, spec);
};

const removeColumnIfPresent = async (queryInterface, wanted, column) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  if (desc[column]) await queryInterface.removeColumn(actual, column);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await addColumnIfMissing(queryInterface, 'LabTests', 'cancelledBy', { type: DataTypes.STRING, allowNull: true });
    await addColumnIfMissing(queryInterface, 'LabTests', 'cancelledByRole', { type: DataTypes.STRING, allowNull: true });
    await addColumnIfMissing(queryInterface, 'LabTests', 'cancelledAt', { type: DataTypes.DATE, allowNull: true });
  },

  async down(queryInterface) {
    await removeColumnIfPresent(queryInterface, 'LabTests', 'cancelledBy');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'cancelledByRole');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'cancelledAt');
  },
};
