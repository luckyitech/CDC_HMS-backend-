'use strict';

// Billing module — seed the price list with the services the clinic already
// bills, so day one looks identical to today.
//
// These 21 names are lifted verbatim from the frontend's
// constants/billingOptions.js (CHARGE_OPTIONS + PROCEDURE_OPTIONS), which is
// what doctors currently tick and what lands in Queue.selectedCharges. The
// checkout resolves those labels back to price list rows BY NAME, so the
// strings must match character for character — including the parenthesised
// abbreviations.
//
// Everything is seeded UNPRICED (unitPriceMinor NULL) and VAT-EXEMPT:
//
//   - Unpriced, because inventing a price would be worse than having none.
//     An unpriced line visibly blocks issuing until the admin sets it on the
//     Price List screen; a guessed one silently mischarges a patient.
//   - Exempt, because most medical services are VAT-exempt in Kenya. The
//     clinic's accountant must confirm the real classification before go-live —
//     this is a safe default, not tax advice.
//
// The two exceptions are 'No Charge' and 'Free Review', priced 0 explicitly:
// their names state the price, and leaving them unpriced would block the
// discharge of every patient who owes nothing, which is a lot of them.
//
// Re-runnable: only names that are missing get inserted.

const TABLE = 'ServiceItems';

// [name, category, unitPriceMinor]
const SERVICES = [
  // --- CHARGE_OPTIONS ---
  ['Consultation Fee',                                       'consultation', null],
  ['Free Review',                                            'consultation', 0],
  ['No Charge',                                              'other',        0],
  ['Random Blood Sugar',                                     'laboratory',   null],
  ['Ketones',                                                'laboratory',   null],
  ['HbA1c',                                                  'laboratory',   null],
  ['ECG',                                                    'procedure',    null],

  // --- PROCEDURE_OPTIONS ---
  ['PNS',                                                    'procedure',    null],
  ['ABI',                                                    'procedure',    null],
  ['ANS',                                                    'procedure',    null],
  ['Dressing Major',                                         'procedure',    null],
  ['Dressing Minor',                                         'procedure',    null],
  ['IV',                                                     'procedure',    null],
  ['CGM',                                                    'procedure',    null],
  ['Insulin Shot',                                           'injection',    null],
  ['Thyroid Ultrasound',                                     'procedure',    null],
  ['Thyroid Nodule Radiofrequency Ablation (RFA)',           'procedure',    null],
  ['Thyroid Percutaneous Ethanol Injection (PEI)',           'procedure',    null],
  ['Ultrasound-Guided Thyroid Fine Needle Aspiration (FNA)', 'procedure',    null],
  ['Ultrasound-Guided Core Needle Biopsy (CNB)',             'procedure',    null],
  ['Foot Pressure Measurement',                              'procedure',    null],
];

const tableExists = async (queryInterface) => {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    const [existing] = await queryInterface.sequelize.query(
      `SELECT name FROM ${TABLE}`
    );
    const have = new Set(existing.map((row) => row.name));

    const rows = SERVICES
      .filter(([name]) => !have.has(name))
      .map(([name, category, unitPriceMinor]) => ({
        name,
        category,
        unitPriceMinor,
        vatClass: 'exempt',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    if (rows.length) await queryInterface.bulkInsert(TABLE, rows);
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface))) return;

    // Only the seeded names, and only those never billed — a service item
    // referenced by an invoice line stays, because removing it would strand the
    // reporting link on a real bill.
    await queryInterface.sequelize.query(
      `DELETE FROM ${TABLE}
        WHERE name IN (:names)
          AND id NOT IN (SELECT DISTINCT serviceItemId FROM InvoiceLines WHERE serviceItemId IS NOT NULL)`,
      { replacements: { names: SERVICES.map(([name]) => name) } }
    );
  },
};
