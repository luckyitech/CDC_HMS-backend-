'use strict';

/**
 * Index the date/timestamp columns the admin Activity Log (and per-staff
 * activity tab) filter on. Both read every row from these tables — this
 * alone doesn't bound that, but it keeps the date-filtered queries fast
 * as each table grows. Additive and idempotent; safe to re-run.
 */

const actualTableName = async (queryInterface, wanted) =>
  (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === String(wanted).toLowerCase()) || null;

const addIndexIfMissing = async (queryInterface, wanted, columns, name) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  if (!columns.every((c) => desc[c])) return;
  try {
    await queryInterface.addIndex(actual, columns, { name });
  } catch (err) {
    if (!/duplicate|exists/i.test(err.message || '')) throw err;
  }
};

const removeIndexIfPresent = async (queryInterface, wanted, name) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  try {
    await queryInterface.removeIndex(actual, name);
  } catch (err) {
    if (!/doesn't exist|does not exist|not found/i.test(err.message || '')) throw err;
  }
};

const INDEXES = [
  ['Patients',            ['createdAt'],       'patients_created_at'],
  ['Queues',               ['createdAt'],       'queues_created_at'],
  ['MedicalDocuments',     ['createdAt'],       'medical_documents_created_at'],
  ['MedicalDocuments',     ['reviewDate'],      'medical_documents_review_date'],
  ['MedicalEquipments',    ['addedDate'],       'medical_equipment_added_date'],
  ['MedicalEquipments',    ['lastUpdatedDate'], 'medical_equipment_last_updated_date'],
  ['EquipmentHistories',   ['archivedDate'],    'equipment_histories_archived_date'],
  ['Prescriptions',        ['createdAt'],       'prescriptions_created_at'],
  ['LabTests',             ['createdAt'],       'lab_tests_created_at'],
  ['LabTests',             ['cancelledAt'],     'lab_tests_cancelled_at'],
  ['TreatmentPlans',       ['createdAt'],       'treatment_plans_created_at'],
  ['ConsultationNotes',    ['createdAt'],       'consultation_notes_created_at'],
  ['ConsultationNotes',    ['updatedAt'],       'consultation_notes_updated_at'],
  ['PhysicalExaminations', ['createdAt'],       'physical_examinations_created_at'],
  ['InitialAssessments',   ['createdAt'],       'initial_assessments_created_at'],
  ['Users',                ['createdAt'],       'users_created_at'],
  ['UserLoginLogs',        ['loginAt'],         'user_login_logs_login_at'],
  ['Appointments',         ['createdAt'],       'appointments_created_at'],
  ['Appointments',         ['cancelledAt'],     'appointments_cancelled_at'],
  ['DoctorBlocks',         ['createdAt'],       'doctor_blocks_created_at'],
  ['BarcodeScans',         ['createdAt'],       'barcode_scans_created_at'],
];

module.exports = {
  async up(queryInterface) {
    for (const [table, columns, name] of INDEXES) {
      await addIndexIfMissing(queryInterface, table, columns, name);
    }
  },

  async down(queryInterface) {
    for (const [table, , name] of INDEXES) {
      await removeIndexIfPresent(queryInterface, table, name);
    }
  },
};
