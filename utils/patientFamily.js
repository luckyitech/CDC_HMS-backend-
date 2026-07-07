const db = require('../models');
const { Patient } = db;

/**
 * Resolves a patient by UHID and returns the full "family" context needed
 * for merge-aware reads and write-blocking.
 *
 * Returns null if UHID does not exist.
 *
 * @returns {{ patient, patientIds: number[], isDeactivated: boolean } | null}
 *   patient        — the Patient row for the requested UHID
 *   patientIds     — IDs to use in Op.in for READ queries:
 *                      active canonical → [self, ...all merged-in patients]
 *                      deactivated      → [self] (only their own historical data)
 *   isDeactivated  — true when the patient was merged into another record
 */
const resolvePatient = async (uhid) => {
  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) return null;

  const isDeactivated = patient.mergedIntoId !== null;

  let patientIds;
  if (isDeactivated) {
    patientIds = [patient.id];
  } else {
    const merged = await Patient.findAll({
      where:      { mergedIntoId: patient.id },
      attributes: ['id'],
    });
    patientIds = [patient.id, ...merged.map((m) => m.id)];
  }

  return { patient, patientIds, isDeactivated };
};

module.exports = { resolvePatient };
