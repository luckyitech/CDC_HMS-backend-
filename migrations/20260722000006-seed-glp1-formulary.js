'use strict';

/**
 * Seeds the GLP-1 formulary and the symptom catalogue.
 *
 * Written as a migration rather than a seeder because seeders are never run
 * against production — the runbook is git pull → npm install → npm run migrate
 * → pm2 restart, and re-running the seeders on a live database is forbidden.
 *
 * Idempotent by name, so a database that already has these rows is left alone.
 * The dose ladders are the clinic defaults; each patient gets an editable copy
 * on their own therapy row, so changing a ladder here never rewrites a course
 * already in progress.
 */

const MEDICATIONS = [
  {
    genericName:           'Tirzepatide',
    brandName:             'Mounjaro',
    drugClass:             'GIP/GLP-1 RA',
    route:                 'SC weekly',
    strengths:             [2.5, 5, 7.5, 10, 12.5, 15],
    defaultSchedule: [
      { fromWeek: 0,  toWeek: 4,    dose: 2.5,  note: 'Initiation' },
      { fromWeek: 4,  toWeek: 8,    dose: 5 },
      { fromWeek: 8,  toWeek: 12,   dose: 7.5 },
      { fromWeek: 12, toWeek: 16,   dose: 10 },
      { fromWeek: 16, toWeek: 20,   dose: 12.5 },
      { fromWeek: 20, toWeek: null, dose: 15,   note: 'Maximum dose' },
    ],
    defaultTitrationWeeks: 4,
  },
  {
    genericName:           'Semaglutide',
    brandName:             'Ozempic / Wegovy',
    drugClass:             'GLP-1 RA',
    route:                 'SC weekly',
    strengths:             [0.25, 0.5, 1, 1.7, 2, 2.4],
    defaultSchedule: [
      { fromWeek: 0,  toWeek: 4,    dose: 0.25, note: 'Initiation' },
      { fromWeek: 4,  toWeek: 8,    dose: 0.5 },
      { fromWeek: 8,  toWeek: 12,   dose: 1 },
      { fromWeek: 12, toWeek: 16,   dose: 1.7 },
      { fromWeek: 16, toWeek: null, dose: 2.4,  note: 'Maximum dose' },
    ],
    defaultTitrationWeeks: 4,
  },
];

const SYMPTOMS = [
  'Nausea',
  'Vomiting',
  'Diarrhoea',
  'Constipation',
  'Abdominal pain',
  'Heartburn',
  'Low appetite',
  'Dizziness',
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const now    = new Date();

    // --- Formulary ---
    if (tables.includes('Glp1Medications')) {
      const [existing] = await queryInterface.sequelize.query(
        'SELECT genericName FROM Glp1Medications'
      );
      const have = new Set(existing.map((r) => r.genericName));

      const rows = MEDICATIONS
        .filter((m) => !have.has(m.genericName))
        .map((m) => ({
          genericName:           m.genericName,
          brandName:             m.brandName,
          drugClass:             m.drugClass,
          route:                 m.route,
          strengths:             JSON.stringify(m.strengths),
          defaultSchedule:       JSON.stringify(m.defaultSchedule),
          defaultTitrationWeeks: m.defaultTitrationWeeks,
          isActive:              true,
          addedBy:               null,
          createdAt:             now,
          updatedAt:             now,
        }));

      if (rows.length) await queryInterface.bulkInsert('Glp1Medications', rows);
    }

    // --- Symptom catalogue ---
    if (tables.includes('Glp1SideEffectCatalogs')) {
      const [existing] = await queryInterface.sequelize.query(
        'SELECT name FROM Glp1SideEffectCatalogs'
      );
      const have = new Set(existing.map((r) => r.name));

      const rows = SYMPTOMS
        .map((name, i) => ({ name, sortOrder: (i + 1) * 10 }))
        .filter((s) => !have.has(s.name))
        .map((s) => ({
          name:      s.name,
          isActive:  true,
          sortOrder: s.sortOrder,
          addedBy:   null,
          createdAt: now,
          updatedAt: now,
        }));

      if (rows.length) await queryInterface.bulkInsert('Glp1SideEffectCatalogs', rows);
    }
  },

  async down(queryInterface, Sequelize) {
    const { Op } = Sequelize;
    const tables = await queryInterface.showAllTables();

    // Only removes the seeded rows. Anything the clinic added stays.
    if (tables.includes('Glp1Medications')) {
      await queryInterface.bulkDelete('Glp1Medications', {
        genericName: { [Op.in]: MEDICATIONS.map((m) => m.genericName) },
      });
    }

    if (tables.includes('Glp1SideEffectCatalogs')) {
      await queryInterface.bulkDelete('Glp1SideEffectCatalogs', {
        name: { [Op.in]: SYMPTOMS },
      });
    }
  },
};
