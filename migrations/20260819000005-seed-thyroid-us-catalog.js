'use strict';

/**
 * Seeds the thyroid US indication and plan vocabularies. Idempotent — only
 * inserts codes that are not already present, so it is safe to re-run.
 */
const INDICATIONS = [
  ['goitre', 'Goitre'],
  ['nodule_palpation', 'Nodule on palpation'],
  ['incidental_nodule', 'Incidental nodule'],
  ['abnormal_tfts', 'Abnormal thyroid function tests'],
  ['surveillance', 'Nodule surveillance'],
  ['post_ablation', 'Post-ablation follow-up'],
  ['post_fnac', 'Post-FNAC follow-up'],
  ['family_history', 'Family history of thyroid disease/cancer'],
  ['neck_pain', 'Neck pain / tenderness'],
  ['pressure_symptoms', 'Dysphagia / pressure symptoms'],
  ['other', 'Other'],
];

const PLANS = [
  ['fna', 'FNA / biopsy'],
  ['surveillance_6', 'Ultrasound surveillance — 6 months'],
  ['surveillance_12', 'Ultrasound surveillance — 12 months'],
  ['tfts', 'Thyroid function tests'],
  ['endocrinology_referral', 'Endocrinology referral'],
  ['surgical_referral', 'Surgical referral'],
  ['rfa', 'Radiofrequency ablation (RFA)'],
  ['pea', 'Percutaneous ethanol ablation (PEA)'],
  ['pea_rfa', 'PEA + RFA'],
  ['no_further_imaging', 'No further imaging'],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.map((t) => t.toLowerCase()).includes('thyroiduscatalogitems')) return;

    const [rows] = await queryInterface.sequelize.query('SELECT type, code FROM ThyroidUsCatalogItems');
    const existing = new Set(rows.map((r) => `${r.type}:${r.code}`));

    const now = new Date();
    const toInsert = [];
    INDICATIONS.forEach(([code, label], i) => {
      if (!existing.has(`indication:${code}`)) toInsert.push({ type: 'indication', code, label, isActive: true, sortOrder: i, createdAt: now, updatedAt: now });
    });
    PLANS.forEach(([code, label], i) => {
      if (!existing.has(`plan:${code}`)) toInsert.push({ type: 'plan', code, label, isActive: true, sortOrder: i, createdAt: now, updatedAt: now });
    });

    if (toInsert.length) await queryInterface.bulkInsert('ThyroidUsCatalogItems', toInsert);
  },

  async down(queryInterface) {
    const codes = [...INDICATIONS.map((x) => x[0]), ...PLANS.map((x) => x[0])];
    await queryInterface.bulkDelete('ThyroidUsCatalogItems', { code: codes });
  },
};
