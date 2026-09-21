const { Op } = require('sequelize');
const db = require('../models');

const { Patient, User } = db;

// ---------------------------------------------------------------------------
// Phone normalisation + phone→patient lookup for the Communications Inbox.
//
// WhatsApp identifies a contact by a `wa_id` — the full international number
// with no '+' (Kenya: 2547XXXXXXXX). Our records store phones however they
// were typed (07XX XXX XXX, +254 7XX…, 254…). So every comparison is done on
// the last 9 digits, which is stable across all of those shapes — the same
// approach labReportMatch.js already uses for lab reports (its private
// normaliser is promoted here so there is one phone helper for the whole app).
//
// findPatientsByPhone is merge-aware (A4): it collapses every hit to its
// canonical patient and de-dupes, so a shared/household number returns the
// distinct people who use it and auto-link only fires on exactly one.
// ---------------------------------------------------------------------------

const KENYA_CC = '254';

/** Any input → its last 9 digits ('7XXXXXXXX'), or null if too short. */
const normalisePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
};

/** Any input → a WhatsApp wa_id ('2547XXXXXXXX'), or null. Assumes Kenya. */
const toWaId = (raw) => {
  const last9 = normalisePhone(raw);
  return last9 ? `${KENYA_CC}${last9}` : null;
};

/** A wa_id / raw number → a readable local form ('0712 345 678'). */
const display = (raw) => {
  const last9 = normalisePhone(raw);
  if (!last9) return raw ? String(raw) : '';
  // 7XXXXXXXX → 0712 345 678
  return `0${last9}`.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3');
};

// A phone column compared on its trailing digits: strip spaces, dashes and a
// leading '+' in SQL, then match the last 9. Same shape as labReportMatch's
// phoneWhere, kept local so this file has no cross-import cycle.
const suffixWhere = (col, last9) => db.sequelize.where(
  db.sequelize.fn('REPLACE',
    db.sequelize.fn('REPLACE',
      db.sequelize.fn('REPLACE', db.sequelize.col(col), ' ', ''), '-', ''), '+', ''),
  { [Op.like]: `%${last9}` },
);

const PATIENT_ATTRS = ['id', 'uhid', 'firstName', 'lastName', 'phone', 'dateOfBirth', 'gender', 'mergedIntoId', 'primaryDoctorId', 'status'];

/** Collapse a merged duplicate to its canonical record. */
const canonical = async (p) => {
  if (!p) return null;
  if (!p.mergedIntoId) return p;
  const target = await Patient.findByPk(p.mergedIntoId, { attributes: PATIENT_ATTRS });
  return target ? canonical(target) : p;
};

/**
 * Every distinct canonical patient whose own phone (Patients.phone) or login
 * phone (Users.phone) ends with the same 9 digits as `raw`. Returns [] when the
 * number is unusable or matches nobody.
 *
 * emergencyContact.phone is deliberately NOT matched to a patient here — it is
 * a caregiver's number, not the patient's, so a match on it is only a hint the
 * UI may show, never grounds to auto-link a conversation to that patient.
 */
const findPatientsByPhone = async (raw) => {
  const last9 = normalisePhone(raw);
  if (!last9) return [];

  const [byPatient, byUser] = await Promise.all([
    Patient.findAll({ where: suffixWhere('Patient.phone', last9), attributes: PATIENT_ATTRS, limit: 10 }),
    // The login User carries its own phone; qualify the column since the include
    // joins Patients, which also has a `phone` (unqualified would be ambiguous).
    User.findAll({
      where: { [Op.and]: [suffixWhere('User.phone', last9), { role: 'patient' }] },
      attributes: ['id'],
      include: [{ model: Patient, attributes: PATIENT_ATTRS, required: true }],
      limit: 10,
    }),
  ]);

  const rows = [...byPatient, ...byUser.map((u) => u.Patient).filter(Boolean)];
  const resolved = [];
  for (const r of rows) resolved.push(await canonical(r));
  // distinct by canonical id
  return [...new Map(resolved.filter(Boolean).map((p) => [p.id, p])).values()];
};

module.exports = { normalisePhone, toWaId, display, findPatientsByPhone };
