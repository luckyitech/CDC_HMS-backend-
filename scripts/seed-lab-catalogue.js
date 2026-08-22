'use strict';

/**
 * Seed the labTest clinic catalogue from the Quest Ace Laboratories test menu
 * (compiled 22 Aug 2026). Individual prices are NOT published by the lab, so
 * every test is seeded at KES 0 — set real prices later on the admin Clinical
 * Catalog page (Lab tests tab) or by re-running with prices filled in.
 *
 * Idempotent and safe on a live DB: findOrCreate by (type:'labTest', name), so
 * it only inserts tests that are missing and never touches existing rows or any
 * other catalogue type. Re-runnable.
 *
 *   node scripts/seed-lab-catalogue.js
 *
 * `common: true` marks the diabetes-clinic quick-pick cards shown in the request
 * form; everything else is reached via search. Adjust freely afterwards.
 */

const db = require('../models');
const { CatalogItem } = db;

// { name, sample, common? }
const TESTS = [
  // ── Hematology ──
  { name: 'Hemogram + ESR', sample: 'Blood' },
  { name: 'Total Blood Count', sample: 'Blood', common: true },
  { name: 'Hemoglobin', sample: 'Blood' },
  { name: 'PCV', sample: 'Blood' },
  { name: 'PBF', sample: 'Blood' },
  { name: 'ESR', sample: 'Blood' },
  { name: 'Malaria – QBC', sample: 'Blood' },
  { name: 'Malaria Ag Strip', sample: 'Blood' },
  { name: 'Coombs direct', sample: 'Blood' },
  { name: 'Coombs indirect', sample: 'Blood' },
  { name: 'Coagulation profile (TBC, APTT, BT, CT, INR)', sample: 'Blood' },
  { name: 'Bleeding and clotting time', sample: 'Blood' },
  { name: 'Bleeding Time', sample: 'Blood' },
  { name: 'Clotting Time', sample: 'Blood' },
  { name: 'APTT', sample: 'Blood' },
  { name: 'INR', sample: 'Blood' },
  { name: 'D-dimers', sample: 'Blood' },
  { name: 'Blood Grouping', sample: 'Blood' },
  { name: 'Platelet count', sample: 'Blood' },
  { name: 'WBC count', sample: 'Blood' },
  { name: 'Venesection', sample: 'Blood' },
  { name: 'Sickling test', sample: 'Blood' },
  { name: 'Vitamin B12', sample: 'Blood' },
  { name: 'Vitamin D3', sample: 'Blood' },
  { name: 'Folic Acid', sample: 'Blood' },
  { name: 'Reticulocytes count', sample: 'Blood' },

  // ── Clinical Chemistry — Renal Function ──
  { name: 'UEC', sample: 'Blood', common: true },
  { name: 'Electrolytes', sample: 'Blood' },
  { name: 'Urea', sample: 'Blood' },
  { name: 'Creatinine', sample: 'Blood', common: true },
  { name: 'Uric Acid', sample: 'Blood' },
  { name: 'Calcium', sample: 'Blood' },
  { name: 'Corrected calcium', sample: 'Blood' },
  { name: 'Phosphorous', sample: 'Blood' },
  { name: 'Sodium (Na)', sample: 'Blood' },
  { name: 'Potassium', sample: 'Blood' },
  { name: 'Chloride', sample: 'Blood' },
  { name: 'Magnesium', sample: 'Blood' },
  { name: 'Creatinine Clearance', sample: 'Blood' },
  { name: 'Creatinine Quantitative urine 24 hr', sample: 'Urine' },
  { name: 'Urine Albumin Creatinine Ratio (ACR)', sample: 'Urine' },

  // ── Lipid Profile ──
  { name: 'Lipid Profile', sample: 'Blood', common: true },
  { name: 'Total cholesterol', sample: 'Blood' },
  { name: 'Triglycerides', sample: 'Blood' },
  { name: 'HDL Cholesterol', sample: 'Blood' },
  { name: 'LDL Cholesterol', sample: 'Blood' },
  { name: 'Lipoprotein a', sample: 'Blood' },
  { name: 'Apolipoprotein B', sample: 'Blood' },
  { name: 'Apolipoprotein A', sample: 'Blood' },

  // ── Liver / Pancreatic ──
  { name: 'Liver Function Tests', sample: 'Blood', common: true },
  { name: 'Bilirubin – Total, indirect, direct', sample: 'Blood' },
  { name: 'Total bilirubin', sample: 'Blood' },
  { name: 'Serum Bilirubin (dir/indir)', sample: 'Blood' },
  { name: 'Alkaline Phosphatase (ALP)', sample: 'Blood' },
  { name: 'GGT', sample: 'Blood' },
  { name: 'AST/SGOT', sample: 'Blood' },
  { name: 'ALT/SGPT', sample: 'Blood' },
  { name: 'Amylase', sample: 'Blood' },
  { name: 'Lipase', sample: 'Blood' },
  { name: 'Total Proteins (Proteins, Albumin, Globulin)', sample: 'Blood' },
  { name: 'Serum Protein', sample: 'Blood' },
  { name: 'Albumin', sample: 'Blood' },

  // ── Diabetic Tests ──
  { name: 'Glucose – fasting', sample: 'Blood', common: true },
  { name: 'Glucose – random', sample: 'Blood', common: true },
  { name: 'Glucose post prandial', sample: 'Blood' },
  { name: 'Glucose Tolerance (OGTT)', sample: 'Blood' },
  { name: 'Glucose challenge test', sample: 'Blood' },
  { name: 'HBA1c', sample: 'Blood', common: true },
  { name: 'Fasting C-Peptide', sample: 'Blood' },

  // ── Thyroid Function ──
  { name: 'Thyroid Function Tests', sample: 'Blood', common: true },
  { name: 'TSH', sample: 'Blood' },
  { name: 'Free T3', sample: 'Blood' },
  { name: 'Free T4', sample: 'Blood' },
  { name: 'Thyroid Antibodies', sample: 'Blood' },

  // ── Hormones ──
  { name: 'FSH', sample: 'Blood' },
  { name: 'LH', sample: 'Blood' },
  { name: 'Estrogen', sample: 'Blood' },
  { name: 'Progesterone', sample: 'Blood' },
  { name: 'Prolactin', sample: 'Blood' },
  { name: 'Beta HCG (BHCG)', sample: 'Blood' },
  { name: 'Total Testosterone', sample: 'Blood' },
  { name: 'Cortisol', sample: 'Blood' },
  { name: 'Insulin', sample: 'Blood' },
  { name: 'PTH', sample: 'Blood' },
  { name: 'AMH', sample: 'Blood' },

  // ── Cardiac / Muscle Enzymes ──
  { name: 'HS Troponin T', sample: 'Blood' },
  { name: 'CKMB', sample: 'Blood' },
  { name: 'SGOT', sample: 'Blood' },
  { name: 'CPK', sample: 'Blood' },
  { name: 'LDH', sample: 'Blood' },
  { name: 'Ultra sens CRP (HSCRP)', sample: 'Blood' },
  { name: 'Pro BNP', sample: 'Blood' },
  { name: 'Homocysteine', sample: 'Blood' },

  // ── Iron Studies ──
  { name: 'Total iron', sample: 'Blood' },
  { name: 'Ferritin', sample: 'Blood' },
  { name: 'Total iron binding capacity / Transferrin', sample: 'Blood' },
  { name: 'Iron studies (iron, TIBC, Transferrin, Ferritin)', sample: 'Blood' },

  // ── Tumor Related ──
  { name: 'Alfa feto protein (AFP)', sample: 'Blood' },
  { name: 'CEA', sample: 'Blood' },
  { name: 'CA 125', sample: 'Blood' },
  { name: 'CA 19-9', sample: 'Blood' },
  { name: 'CA 15-3', sample: 'Blood' },
  { name: 'Total PSA', sample: 'Blood' },
  { name: 'Free PSA', sample: 'Blood' },
  { name: 'Free PSA & Total PSA', sample: 'Blood' },

  // ── HIV ──
  { name: 'HIV 1 & 2', sample: 'Blood' },

  // ── Hepatitis ──
  { name: 'Hep A IgM', sample: 'Blood' },
  { name: 'Hep A IgG', sample: 'Blood' },
  { name: 'Hep B surface Ag (HbsAg)', sample: 'Blood' },
  { name: 'Hep B Surface Ab Antibody', sample: 'Blood' },
  { name: 'Hepatitis C Antibody (HCV)', sample: 'Blood' },

  // ── Other Infectious Diseases ──
  { name: 'Rubella antibodies IgG', sample: 'Blood' },
  { name: 'Rubella antibodies IgM', sample: 'Blood' },
  { name: 'VDRL', sample: 'Blood' },
  { name: 'TPHA', sample: 'Blood' },
  { name: 'Chikungunya', sample: 'Blood' },
  { name: 'Dengue IgG, IgM, NS1', sample: 'Blood' },

  // ── Auto-Immune ──
  { name: 'Rheumatoid factor', sample: 'Blood' },
  { name: 'Anti CCP (cobas)', sample: 'Blood' },
  { name: 'Total IgE', sample: 'Blood' },
  { name: 'Complement C3', sample: 'Blood' },
  { name: 'Complement C4', sample: 'Blood' },
  { name: 'ANCA (C & P)', sample: 'Blood' },
  { name: 'ENA Profile', sample: 'Blood' },

  // ── Serology ──
  { name: 'Pregnancy Test', sample: 'Urine' },
  { name: 'Weil Felix', sample: 'Blood' },
  { name: 'Brucella agglutination', sample: 'Blood' },
  { name: 'Stool rota and adeno virus', sample: 'Stool' },
  { name: 'Stool H. pylori antigen strip', sample: 'Stool' },
  { name: 'Salmonella Typhi Ag', sample: 'Blood' },
  { name: 'Rapid Clostridium toxin A/B', sample: 'Stool' },
  { name: 'Stool campylobacter', sample: 'Stool' },
  { name: 'Stool Norovirus', sample: 'Stool' },
  { name: 'ASOT', sample: 'Blood' },
  { name: 'Widal Test', sample: 'Blood' },
  { name: 'Rapid Covid antigen', sample: 'Swab' },
  { name: 'Rapid influenza A/B', sample: 'Swab' },

  // ── Microbiology & Parasitology ──
  { name: 'Urine analysis', sample: 'Urine', common: true },
  { name: 'Bence Jones Protein', sample: 'Urine' },
  { name: 'Sputum for AAFB – ZN and Grams', sample: 'Sputum' },
  { name: 'Urine M/C/S', sample: 'Urine' },
  { name: 'Blood C/S, Single bottle (Aerobic)', sample: 'Blood' },
  { name: 'Blood C/S, Two bottle (Aerobic & Anaerobic)', sample: 'Blood' },
  { name: 'Sputum M/C/S', sample: 'Sputum' },
  { name: 'Pleural fluid M/C/S', sample: 'Fluid' },
  { name: 'Ascitic fluid M/C/S', sample: 'Fluid' },
  { name: 'Synovial fluid M/C/S', sample: 'Fluid' },
  { name: 'High Vaginal Swab M/C/S', sample: 'Swab' },
  { name: 'Semen C/S', sample: 'Semen' },
  { name: 'Throat swab C/S', sample: 'Swab' },
  { name: 'Stool routine with occult blood', sample: 'Stool' },
  { name: 'Stool M/C/S', sample: 'Stool' },
  { name: 'Skin Scrapping – KOH preparation', sample: 'Skin' },

  // ── Therapeutic Drug ──
  { name: 'Drug of abuse panel (10 drugs)', sample: 'Urine' },

  // ── Cytology & Histopathology ──
  { name: 'PAP Smear Staining & Reporting', sample: 'Smear' },
  { name: 'Liquid Based Cytology', sample: 'Smear' },
  { name: 'Biopsies', sample: 'Tissue' },
  { name: 'Semen analysis', sample: 'Semen' },

  // ── Other Common Specialized Tests ──
  { name: 'FIT – Fecal ImmunoChemical Test, Quantitative', sample: 'Stool' },
  { name: 'GAD Type I Diabetes Antibody', sample: 'Blood' },
  { name: 'Anti Insulin Antibody (IAA)', sample: 'Blood' },
  { name: 'TSH Receptor Antibody', sample: 'Blood' },
  { name: 'Endomysial IgG, IgM ABS', sample: 'Blood' },
  { name: 'Anti-Islet Cell Antibodies, Serum', sample: 'Blood' },
  { name: 'Fecal Calprotectin', sample: 'Stool' },
  { name: 'Vitamin B Complex', sample: 'Blood' },
  { name: 'Semen Analysis by CASA Analyzer', sample: 'Semen' },
];

(async () => {
  let added = 0;
  let skipped = 0;
  try {
    for (const t of TESTS) {
      // eslint-disable-next-line no-await-in-loop
      const [, created] = await CatalogItem.findOrCreate({
        where: { type: 'labTest', name: t.name },
        defaults: {
          type: 'labTest',
          name: t.name,
          detail: t.sample || null,
          price: 0,
          isCommon: !!t.common,
        },
      });
      if (created) added += 1; else skipped += 1;
    }
    console.log(`Lab catalogue seed complete: ${added} added, ${skipped} already present (total ${TESTS.length}).`);
    console.log('All seeded at KES 0 — set real prices on the admin Clinical Catalog → Lab tests page.');
  } catch (err) {
    console.error('Lab catalogue seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
})();
