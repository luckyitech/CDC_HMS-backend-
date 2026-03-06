const { Op } = require('sequelize');

// UHID: CDC001, CDC002, ...
// Looks at the last patient by id to derive the next sequential number.
const generateUHID = async (Patient) => {
  const last = await Patient.findOne({ order: [['id', 'DESC']] });
  const num = last ? parseInt(last.uhid.replace('CDC', '')) + 1 : 1;
  return 'CDC' + String(num).padStart(3, '0');
};

// Generic number generator: PREFIX-YYYY-NNN
// Used for prescriptions (RX), lab tests (LAB), appointments (APT).
const generateNumber = async (Model, field, prefix) => {
  const year = new Date().getFullYear();
  const yearPrefix = `${prefix}-${year}-`;
  const last = await Model.findOne({
    where: { [field]: { [Op.like]: `${yearPrefix}%` } },
    order: [[field, 'DESC']],
  });
  const num = last ? parseInt(last[field].split('-').pop()) + 1 : 1;
  return yearPrefix + String(num).padStart(3, '0');
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
