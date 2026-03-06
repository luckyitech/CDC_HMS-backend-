const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { BloodSugarReading } = db;

// ------------------------------------
// Helpers
// ------------------------------------

// Chronological order for time slots — used to sort the response
const SLOT_ORDER = {
  fasting: 0, breakfast: 1, beforeLunch: 2,
  afterLunch: 3, beforeDinner: 4, afterDinner: 5, bedtime: 6,
};

// Set of valid timeSlot keys, derived from SLOT_ORDER
const VALID_SLOTS = new Set(Object.keys(SLOT_ORDER));

// Format one DB row into the API response shape
const formatReading = (r) => ({
  date:     r.date,
  timeSlot: r.timeSlot,
  value:    parseFloat(r.value),   // MySQL DECIMAL → string; convert back to number
  time:     r.time,
});

// ------------------------------------
// POST /api/patients/:uhid/blood-sugar
// Accepts a single reading  { date, timeSlot, value, time }
// or   a bulk array         { date, readings: [...] }
// Uses upsert so a duplicate (patientId, date, timeSlot) is updated, not rejected.
// ------------------------------------
const post = async (req, res) => {
  // Patient can only save their own readings
  if (req.patient.UserId !== req.user.id) return error(res, 'Access denied', 403);

  const { date, readings, timeSlot, value, time } = req.body;

  // Normalise single reading → array so the upsert loop handles both paths
  const slots = readings || (timeSlot ? [{ timeSlot, value, time }] : null);
  if (!slots || !slots.length) return error(res, 'At least one reading is required', 400);

  // Validate every timeSlot before hitting the DB
  const invalid = slots.filter(s => !VALID_SLOTS.has(s.timeSlot));
  if (invalid.length) {
    return error(res, `Invalid timeSlot(s): ${invalid.map(s => s.timeSlot).join(', ')}`, 400);
  }

  // Upsert every slot — ON DUPLICATE KEY UPDATE fires for existing (patientId, date, timeSlot)
  await Promise.all(
    slots.map(s =>
      BloodSugarReading.upsert({
        PatientId: req.patient.id,
        date,
        timeSlot: s.timeSlot,
        value:    s.value,
        time:     s.time,
      })
    )
  );

  // Return every reading saved for that day, in chronological slot order
  const saved = await BloodSugarReading.findAll({
    where: { PatientId: req.patient.id, date },
  });

  return success(res,
    saved.map(formatReading).sort((a, b) => SLOT_ORDER[a.timeSlot] - SLOT_ORDER[b.timeSlot]),
    201
  );
};

// ------------------------------------
// GET /api/patients/:uhid/blood-sugar
// Query params (all optional):
//   days   – last N days        (default 30)
//   date   – single date        YYYY-MM-DD
//   from + to – inclusive range  YYYY-MM-DD … YYYY-MM-DD
// ------------------------------------
const get = async (req, res) => {
  // Patient → own only;  doctor → any patient
  if (req.user.role === 'patient' && req.patient.UserId !== req.user.id) {
    return error(res, 'Access denied', 403);
  }

  const where = { PatientId: req.patient.id };
  const { days, date, from, to } = req.query;

  if (date) {
    where.date = date;                                          // specific day
  } else if (from && to) {
    where.date = { [Op.between]: [from, to] };                  // inclusive range
  } else {
    const n      = parseInt(days) || 30;                        // last N days, default 30
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - n);
    where.date   = { [Op.gte]: cutoff.toISOString().split('T')[0] };
  }

  const readings = await BloodSugarReading.findAll({ where });

  // date DESC, then slot in chronological order within each day
  return success(res, readings.map(formatReading).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return SLOT_ORDER[a.timeSlot] - SLOT_ORDER[b.timeSlot];
  }));
};

module.exports = { post, get };
