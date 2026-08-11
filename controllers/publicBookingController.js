const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { generateNumber, generateUHID } = require('../utils/generateId');
const { resolvePatient } = require('../utils/patientFamily');
const { SLOT_LABELS, SEATS_PER_SLOT, FULL_DAY, prettyTime } = require('../utils/appointmentSlots');
const {
  sendAppointmentConfirmationEmail,
  sendDoctorAppointmentNotificationEmail,
} = require('../utils/emailService');
const SOURCES = require('../config/bookingSources');
const db = require('../models');

const { Appointment, Patient, User, StaffProfile, DoctorBlock } = db;

// ====================================================================
// PUBLIC WEBSITE BOOKING
// --------------------------------------------------------------------
// Unauthenticated. Reuses the internal Appointment engine, slot grid,
// UHID generator and confirmation email (which already embeds the
// patient's Code128 barcode when a uhid is passed). No new tables:
// sources are config, the provisional patient is a normal Patient row
// with registrationComplete=false and no login account.
// ====================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const getSource = (key) => (key && Object.prototype.hasOwnProperty.call(SOURCES, key) ? SOURCES[key] : null);

const isPastDate = (dateStr) => {
  const today = new Date().toISOString().split('T')[0];
  return dateStr < today;
};

const doctorName = (d) => `Dr. ${d.firstName} ${d.lastName}`;

const fmtLongDate = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

// Resolve the doctor(s) a source can book, per its strategy.
const resolveDoctors = async (cfg) => {
  if (cfg.strategy === 'fixed') {
    const doc = await User.findOne({
      where: { email: cfg.doctorEmail, role: 'doctor', isActive: true },
      include: [{ model: StaffProfile, attributes: ['specialty'] }],
    });
    return doc ? [doc] : [];
  }
  // least-loaded
  const where = { role: 'doctor', isActive: true };
  if (Array.isArray(cfg.pool) && cfg.pool.length) where.email = { [Op.in]: cfg.pool };
  return User.findAll({ where, include: [{ model: StaffProfile, attributes: ['specialty'] }] });
};

// For a set of doctors on a date: booked count per (doctorId,label) and blocks.
const dayStateForDoctors = async (doctorIds, date) => {
  const [booked, blocks] = await Promise.all([
    Appointment.findAll({
      where: { doctorId: { [Op.in]: doctorIds }, date, status: { [Op.ne]: 'cancelled' } },
      attributes: ['doctorId', 'timeSlot'],
    }),
    DoctorBlock.findAll({
      where: { doctorId: { [Op.in]: doctorIds }, date },
      attributes: ['doctorId', 'timeSlot'],
    }),
  ]);

  const state = {};
  doctorIds.forEach((id) => { state[id] = { count: {}, blocked: new Set(), dayBlocked: false }; });
  booked.forEach((a) => {
    const s = state[a.doctorId]; if (!s) return;
    s.count[a.timeSlot] = (s.count[a.timeSlot] || 0) + 1;
  });
  blocks.forEach((b) => {
    const s = state[b.doctorId]; if (!s) return;
    if (b.timeSlot === FULL_DAY) s.dayBlocked = true; else s.blocked.add(b.timeSlot);
  });
  return state;
};

// Free seats for one doctor at one slot label.
const freeSeats = (docState, label) => {
  if (docState.dayBlocked || docState.blocked.has(label)) return 0;
  return Math.max(0, SEATS_PER_SLOT - (docState.count[label] || 0));
};

// --------------------------------------------------------------------
// GET /api/public/booking/slots?source=<publicKey>&date=YYYY-MM-DD
// Returns availability only — never patient names or UHIDs.
// --------------------------------------------------------------------
const getSlots = async (req, res) => {
  try {
    const { source, date } = req.query;
    const cfg = getSource(source);
    if (!cfg) return error(res, 'Unknown booking source', 404);
    if (!date || !DATE_RE.test(date)) return error(res, 'A valid date (YYYY-MM-DD) is required', 400);
    if (isPastDate(date)) return error(res, 'Please choose a date from today onward', 400);

    const doctors = await resolveDoctors(cfg);
    if (!doctors.length) return error(res, 'Online booking is temporarily unavailable. Please contact the clinic.', 503);

    const state = await dayStateForDoctors(doctors.map((d) => d.id), date);
    const dayBlocked = doctors.every((d) => state[d.id].dayBlocked);

    const label = cfg.strategy === 'fixed' ? doctorName(doctors[0]) : 'Next available specialist';

    if (dayBlocked) {
      return success(res, { date, doctorLabel: label, dayBlocked: true, unavailableReason: null, slots: [] });
    }

    const slots = SLOT_LABELS.map((time) => {
      const seatsLeft = doctors.reduce((sum, d) => sum + freeSeats(state[d.id], time), 0);
      return { time, value: time, available: seatsLeft > 0, seatsLeft };
    });

    return success(res, { date, doctorLabel: label, dayBlocked: false, unavailableReason: null, slots });
  } catch (err) {
    console.error('PublicBooking.getSlots error:', err);
    return error(res, 'Could not load available times', 500);
  }
};

// --------------------------------------------------------------------
// POST /api/public/booking
// Creates a provisional patient (if new) + a scheduled appointment,
// then reuses the confirmation email (barcode embedded via uhid).
// --------------------------------------------------------------------
const book = async (req, res) => {
  try {
    const { source, secret, name, phone, email, country, reason, date, time, message, company, dob } = req.body;

    // Honeypot — bots fill the hidden field. Pretend success, do nothing.
    if (company && String(company).trim() !== '') return success(res, { received: true });

    const cfg = getSource(source);
    if (!cfg) return error(res, 'Unknown booking source', 404);
    if (cfg.secretKey && secret !== cfg.secretKey) return error(res, 'Forbidden', 403);

    // Validation
    if (!name || !phone || !email || !date || !time || !dob) return error(res, 'Please complete all required fields', 422);
    if (!EMAIL_RE.test(email)) return error(res, 'Please enter a valid email address', 422);
    if (!DATE_RE.test(date) || isPastDate(date)) return error(res, 'Please choose a valid date from today onward', 422);
    if (!SLOT_LABELS.includes(time)) return error(res, 'Please choose a valid time slot', 422);
    // Date of birth: must be a real past date (completes the patient file)
    if (!DATE_RE.test(dob) || !isPastDate(dob) || dob < '1900-01-01') {
      return error(res, 'Please enter a valid date of birth', 422);
    }

    // Per-source daily cap (abuse guard)
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const todayCount = await Appointment.count({
      where: { bookedByRole: 'website', bookedBy: cfg.label, createdAt: { [Op.gte]: startOfToday } },
    });
    if (todayCount >= cfg.dailyCap) {
      return error(res, 'Online booking limit reached for today. Please contact the clinic to book.', 429);
    }

    // Resolve + assign the doctor (browser never chooses one)
    const doctors = await resolveDoctors(cfg);
    if (!doctors.length) return error(res, 'Online booking is temporarily unavailable. Please contact the clinic.', 503);

    const state = await dayStateForDoctors(doctors.map((d) => d.id), date);
    const freeDocs = doctors.filter((d) => freeSeats(state[d.id], time) > 0);
    if (!freeDocs.length) return error(res, 'That time was just taken. Please choose another slot.', 409);

    let assigned = freeDocs[0];
    if (cfg.strategy === 'least-loaded' && freeDocs.length > 1) {
      const todayStr = new Date().toISOString().split('T')[0];
      const loads = await Promise.all(freeDocs.map((d) =>
        Appointment.count({ where: { doctorId: d.id, date: { [Op.gte]: todayStr }, status: { [Op.ne]: 'cancelled' } } })
      ));
      let best = 0;
      for (let i = 1; i < freeDocs.length; i++) if (loads[i] < loads[best]) best = i;
      assigned = freeDocs[best];
    }

    // Match an existing file (existing patients rarely book online, but guard
    // against the same new person booking twice) — merge-aware.
    let patient = null;
    const existing = await Patient.findOne({
      where: { [Op.or]: [{ phone }, { email }] },
      order: [['createdAt', 'ASC']],
    });
    if (existing) {
      const family = await resolvePatient(existing.uhid);
      if (family && !family.isDeactivated) {
        patient = family.patient;
        // Backfill DOB only if the file doesn't have one — never overwrite.
        if (!patient.dateOfBirth) await patient.update({ dateOfBirth: dob });
      }
    }

    // Create a provisional patient (no login account; staff complete at reception)
    if (!patient) {
      const tokens = String(name).trim().split(/\s+/);
      const firstName = tokens[0];
      const lastName = tokens.slice(1).join(' ') || '-';
      const uhid = await generateUHID(Patient);
      patient = await Patient.create({
        uhid,
        firstName,
        lastName,
        phone,
        email,
        dateOfBirth: dob,
        status: 'Active',
        registrationComplete: false,
        registeredBy: cfg.label,
        registeredByRole: 'website',
        primaryDoctorId: assigned.id,
      });
    }

    // Create the appointment (same shape the internal booker uses)
    const appointmentNumber = await generateNumber(Appointment, 'appointmentNumber', 'APT');
    const notesParts = [`Website booking via ${cfg.label}.`];
    if (country) notesParts.push(`Country: ${country}.`);
    if (message) notesParts.push(String(message).slice(0, 2000));

    const appt = await Appointment.create({
      appointmentNumber,
      PatientId: patient.id,
      doctorId: assigned.id,
      date,
      timeSlot: time,
      duration: cfg.defaults.duration,
      appointmentType: cfg.defaults.appointmentType,
      reason: reason || cfg.defaults.reasonFallback,
      notes: notesParts.join(' '),
      status: 'scheduled',
      bookedAt: new Date(),
      bookedBy: cfg.label,
      bookedByRole: 'website',
      bookedById: null,
    });

    const specialty = assigned.StaffProfile?.specialty || cfg.defaults.specialty || 'General';
    const patientFullName = `${patient.firstName} ${patient.lastName}`.trim();

    // Confirmation to patient — barcode is embedded automatically via uhid.
    if (patient.email) {
      sendAppointmentConfirmationEmail({
        to: patient.email,
        patientName: patientFullName,
        doctorName: doctorName(assigned),
        specialty,
        uhid: patient.uhid,
        date,
        timeSlot: time,
        appointmentType: appt.appointmentType,
        appointmentNumber,
        reason: appt.reason,
      }).catch(() => {});
    }
    // Notify the assigned doctor.
    if (assigned.email) {
      sendDoctorAppointmentNotificationEmail({
        to: assigned.email,
        doctorName: doctorName(assigned),
        patientName: patientFullName,
        uhid: patient.uhid,
        date,
        timeSlot: time,
        appointmentType: appt.appointmentType,
        appointmentNumber,
        reason: appt.reason,
      }).catch(() => {});
    }

    return success(res, {
      appointmentNumber,
      uhid: patient.uhid,
      doctorName: doctorName(assigned),
      prettyDate: fmtLongDate(date),
      prettyTime: prettyTime(time),
    }, 201);
  } catch (err) {
    console.error('PublicBooking.book error:', err);
    return error(res, 'Could not complete your booking. Please try again or contact the clinic.', 500);
  }
};

// Pure helpers exposed for unit testing (no DB access).
const _internals = { freeSeats, isPastDate, fmtLongDate, getSource };

module.exports = { getSlots, book, _internals };
