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

// Employee ID: EMP001, EMP002, ...
// The staff equivalent of a UHID, and generated the same way — compare the
// numbers numerically rather than sorting the strings, because 'EMP999' sorts
// above 'EMP1000'. See the note on generateNumber below for what that bug
// looked like in production.
const generateEmployeeId = async (StaffProfile) => {
  const profiles = await StaffProfile.findAll({
    where: { employeeId: { [Op.regexp]: '^EMP[0-9]+$' } },
    attributes: ['employeeId'],
    raw: true,
  });
  if (!profiles.length) return 'EMP001';

  const nums = profiles
    .map((p) => parseInt(p.employeeId.replace('EMP', ''), 10))
    .filter((n) => !isNaN(n));
  if (!nums.length) return 'EMP001';

  return 'EMP' + String(Math.max(...nums) + 1).padStart(3, '0');
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

// Requisition Number: REQ-2026-001, REQ-2026-002, ...
// One per lab request (a request can hold several tests, all sharing this number).
const generateRequisitionNumber = async (LabTest) => {
  return generateNumber(LabTest, 'requisitionNumber', 'REQ');
};

module.exports = {
  generateUHID,
  generateEmployeeId,
  generateNumber,
  generatePrescriptionNumber,
  generateLabTestNumber,
  generateRequisitionNumber,
};
