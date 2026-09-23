'use strict';

/**
 * Re-applies 20260722000012-catalogue-glp1-agents on a database where that
 * migration is recorded as applied in SequelizeMeta but never took effect.
 *
 * Production symptom (B4, live since the 22-Aug kardex rewrite):
 *   Unknown column 'Glp1Therapy.medicationName'
 * Every GLP-1 request 500s because models/Glp1Therapy.js reads medicationName
 * and medicationBrand, while prod's Glp1Therapies still carries the original
 * Glp1MedicationId FK and neither name column.
 *
 * 000012 is the migration that adds those columns, backfills them from the old
 * Glp1Medications formulary, drops the FK + column, makes medicationName NOT
 * NULL and drops the formulary table. It is fully guarded — but Sequelize only
 * runs a migration file once per name, so once 000012 is in SequelizeMeta it
 * will never run again, whatever the schema looks like. A fresh filename is the
 * only way to get its steps executed on prod.
 *
 * This file therefore delegates to 000012 verbatim (one implementation, not a
 * second copy that could drift). Every step inside is idempotent:
 *   - on a database that already has the columns (any DB built by sync() from
 *     the current model, e.g. local dev) every guard no-ops and nothing changes;
 *   - on prod it performs the add / backfill / FK drop / NOT NULL / drop-table
 *     sequence exactly as designed in August.
 *
 * Reversal delegates to 000012's structural down (removes the two name columns,
 * restores a nullable Glp1MedicationId and an empty Glp1Medications table). Note
 * that rolling back re-creates the live 500 — restore from the pre-deploy dump
 * if a real rollback is ever needed.
 */

const original = require('./20260722000012-catalogue-glp1-agents');

module.exports = {
  async up(queryInterface, Sequelize) {
    return original.up(queryInterface, Sequelize);
  },

  async down(queryInterface, Sequelize) {
    return original.down(queryInterface, Sequelize);
  },
};
