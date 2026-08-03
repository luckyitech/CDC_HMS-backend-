const { Op } = require('sequelize');

// UHID: CDC001, CDC002, ...
// Finds the highest valid CDC-prefixed UHID to derive the next number.
const generateUHID = async (Patient) => {
  const patients = await Patient.findAll({
    where: { uhid: { [Op.regexp]: '^CDC[0-9]+$' } },
  });
  if (!patients.length) return 'CDC001';
  const nums = patients.map(p => parseInt(p.uhid.replace('CDC', ''))).filter(n => !isNaN(n));
  if (!nums.length) return 'CDC001';
  const max = Math.max(...nums);
  return 'CDC' + String(max + 1).padStart(3, '0');
};

// Generic number generator: PREFIX-YYYY-NNN
// Used for prescriptions (RX), lab tests (LAB), appointments (APT).
//
// The suffix is padded to 3 digits, so widths stay equal only up to 999. Past
// that the column can no longer be ordered as a string: 'APT-2026-999' sorts
// ABOVE 'APT-2026-1000' because '9' > '1'. Ordering by the raw column therefore
// pinned the highest number at 999 forever and regenerated the same
// 'APT-2026-1000' on every call, colliding with the unique index and failing
// every booking after the 1000th of the year.
//
// So compare numerically instead — same approach generateUHID already uses.
const generateNumber = async (Model, field, prefix) => {
  const year = new Date().getFullYear();
  const yearPrefix = `${prefix}-${year}-`;
  const rows = await Model.findAll({
    where: { [field]: { [Op.like]: `${yearPrefix}%` } },
    attributes: [field],
    raw: true,
  });
  const max = rows.reduce((highest, row) => {
    const n = parseInt(String(row[field]).split('-').pop(), 10);
    return !isNaN(n) && n > highest ? n : highest;
  }, 0);
  return yearPrefix + String(max + 1).padStart(3, '0');
};

// Prescription Number: RX-2025-001, RX-2025-002, ...
const generatePrescriptionNumber = async (Prescription) => {
  return generateNumber(Prescription, 'prescriptionNumber', 'RX');
};

// Lab Test Number: LAB-2025-001, LAB-2025-002, ...
const generateLabTestNumber = async (LabTest) => {
  return generateNumber(LabTest, 'testNumber', 'LAB');
};

module.exports = { generateUHID, generateNumber, generatePrescriptionNumber, generateLabTestNumber };
