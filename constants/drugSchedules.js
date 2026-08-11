// Shared drug-schedule source (backend mirror).
//
// SINGLE SOURCE for every drug dropdown — outpatient prescriptions AND the
// inpatient MAR. The frontend has an identical list at
// frontend/cdc-hms/src/constants/drugSchedules.js. Keep the two in sync.
//
// Each schedule carries a human `label` (used by the prescription dropdown) and
// its administration `times` on the clinic's fixed rounds (used by the inpatient
// MAR due-list). Clinic rounds: 06:00 / 12:00 / 22:00 / 00:00 + PRN.
// More schedules can be appended later; this may be promoted to an admin-managed
// table without changing consumers.

const DRUG_SCHEDULES = [
  { code: 'OD',    label: 'Once daily',        times: ['06:00'] },
  { code: 'BD',    label: 'Twice daily',       times: ['06:00', '22:00'] },
  { code: 'TDS',   label: 'Three times daily', times: ['06:00', '12:00', '22:00'] },
  { code: 'QDS',   label: 'Four times daily',  times: ['06:00', '12:00', '22:00', '00:00'] },
  { code: 'Q8H',   label: 'Every 8 hours',     times: ['06:00', '12:00', '22:00'] },
  { code: 'Q12H',  label: 'Every 12 hours',    times: ['06:00', '22:00'] },
  { code: 'NOCTE', label: 'At night',          times: ['22:00'] },
  { code: 'PRN',   label: 'As required',       times: [] },   // no scheduled round
];

// The distinct fixed round times the MAR due-list iterates over.
const DRUG_ROUNDS = ['06:00', '12:00', '22:00', '00:00'];

const scheduleByCode  = (code)  => DRUG_SCHEDULES.find((s) => s.code === code) || null;
const scheduleByLabel = (label) => DRUG_SCHEDULES.find((s) => s.label === label) || null;

module.exports = { DRUG_SCHEDULES, DRUG_ROUNDS, scheduleByCode, scheduleByLabel };
