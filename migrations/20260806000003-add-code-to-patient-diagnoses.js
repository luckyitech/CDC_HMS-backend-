'use strict';

/**
 * Adds PatientDiagnoses.code — optional catalog code (e.g. ICD), matching the
 * {code, description} shape used by DiagnosisInput / treatment plans.
 * Guarded: safe whether or not 20260806000002 has already been run.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.map((t) => String(t).toLowerCase()).includes('patientdiagnoses')) return;
    const table = await queryInterface.describeTable('PatientDiagnoses');
    if (!table.code) {
      await queryInterface.addColumn('PatientDiagnoses', 'code', {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.map((t) => String(t).toLowerCase()).includes('patientdiagnoses')) return;
    const table = await queryInterface.describeTable('PatientDiagnoses');
    if (table.code) {
      await queryInterface.removeColumn('PatientDiagnoses', 'code');
    }
  },
};
