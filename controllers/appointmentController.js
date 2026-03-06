const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { generateNumber } = require('../utils/generateId');
const db = require('../models');
const {
  sendAppointmentConfirmationEmail,
  sendDoctorAppointmentNotificationEmail,
  sendAppointmentCancellationEmail,
  sendDoctorAppointmentCancellationEmail,
} = require('../utils/emailService');

const { Appointment, Patient, User, DoctorProfile } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Formats a single appointment for the API response.
 */
const formatAppointment = (appointment) => {
  const a = appointment.dataValues || appointment;
  return {
    id: a.id,
    appointmentNumber: a.appointmentNumber,
    uhid: a.Patient?.uhid || null,
    patientName: a.Patient
      ? `${a.Patient.firstName} ${a.Patient.lastName}`
      : null,
    doctorName: a.doctor
      ? `Dr. ${a.doctor.firstName} ${a.doctor.lastName}`
      : null,
    specialty: a.doctor?.DoctorProfile?.specialty || null,
    date: a.date,
    timeSlot: a.timeSlot,
    duration: a.duration,
    appointmentType: a.appointmentType,
    reason: a.reason,
    notes: a.notes,
    status: a.status,
    bookedAt: a.bookedAt,
  };
};

/**
 * Reusable "include" configuration for Sequelize queries.
 */
const appointmentIncludes = [
  {
    model: Patient,
    attributes: ['uhid', 'firstName', 'lastName', 'email'],
  },
  {
    model: User,
    as: 'doctor',
    attributes: ['firstName', 'lastName', 'email'],
    include: [
      {
        model: DoctorProfile,
        attributes: ['specialty'],
      },
    ],
  },
];

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/appointments
 * Books a new appointment
 *
 * Authorization: Only patients can book appointments
 *
 * Request body expects:
 * - doctorId: Doctor's user ID
 * - date: Appointment date (YYYY-MM-DD)
 * - timeSlot: Time slot (e.g., "9:00 AM")
 * - appointmentType: Type of appointment
 * - reason: Reason for appointment
 * - notes: Additional notes (optional)
 *
 * Controller auto-sets:
 * - appointmentNumber: APT-YYYY-NNN format
 * - patientId: From JWT token
 * - status: 'scheduled'
 * - bookedAt: Current timestamp
 */
const book = async (req, res) => {
  const { doctorId, date, timeSlot, appointmentType, reason, notes } = req.body;

  // Find patient from logged-in user
  const patient = await Patient.findOne({ where: { userId: req.user.id } });
  if (!patient) {
    return error(res, 'Patient profile not found', 404);
  }

  // Verify doctor exists
  const doctor = await User.findByPk(doctorId);
  if (!doctor || doctor.role !== 'doctor') {
    return error(res, 'Doctor not found', 404);
  }

  // Generate appointment number
  const appointmentNumber = await generateNumber(
    Appointment,
    'appointmentNumber',
    'APT'
  );

  // Create appointment
  const appointment = await Appointment.create({
    appointmentNumber,
    PatientId: patient.id, // PascalCase FK
    doctorId,
    date,
    timeSlot,
    duration: '30 minutes', // Default duration
    appointmentType,
    reason,
    notes: notes || '',
    status: 'scheduled',
    bookedAt: new Date(),
  });

  // Re-fetch with relationships
  const full = await Appointment.findByPk(appointment.id, {
    include: appointmentIncludes,
  });

  const formatted = formatAppointment(full);

  // Send confirmation email to patient (fire-and-forget)
  if (patient.email) {
    sendAppointmentConfirmationEmail({
      to: patient.email,
      patientName: `${patient.firstName} ${patient.lastName}`,
      doctorName: formatted.doctorName,
      specialty: formatted.specialty,
      date: formatted.date,
      timeSlot: formatted.timeSlot,
      appointmentType: formatted.appointmentType,
      appointmentNumber: formatted.appointmentNumber,
      reason: formatted.reason,
    }).catch(() => {});
  }

  // Send notification email to doctor (fire-and-forget)
  if (doctor.email) {
    sendDoctorAppointmentNotificationEmail({
      to: doctor.email,
      doctorName: `Dr. ${doctor.firstName} ${doctor.lastName}`,
      patientName: `${patient.firstName} ${patient.lastName}`,
      uhid: patient.uhid,
      date: formatted.date,
      timeSlot: formatted.timeSlot,
      appointmentType: formatted.appointmentType,
      appointmentNumber: formatted.appointmentNumber,
      reason: formatted.reason,
    }).catch(() => {});
  }

  return success(res, formatted, 201);
};

/**
 * GET /api/appointments
 * Lists appointments with filters
 *
 * Query parameters:
 * - uhid: Patient UHID (optional, auto-set for patient role)
 * - doctor: Doctor ID (optional)
 * - date: Specific date or "today" (optional)
 * - status: scheduled, checked-in, completed, cancelled (optional)
 * - page: Page number (default 1)
 * - limit: Items per page (default 20)
 *
 * Patient role: Automatically filters to their own appointments
 */
const list = async (req, res) => {
  const { uhid, doctor, date, status, page = 1, limit = 20 } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);

  // Build WHERE clause
  const where = {};
  if (status) {
    where.status = status;
  }
  if (doctor) {
    where.doctorId = parseInt(doctor);
  }
  if (date) {
    // Support "today" keyword
    if (date === 'today') {
      where.date = new Date().toISOString().split('T')[0];
    } else {
      where.date = date;
    }
  }

  // Build includes with optional filters
  const includes = [
    {
      model: Patient,
      attributes: ['uhid', 'firstName', 'lastName'],
      ...(uhid && { where: { uhid }, required: true }),
    },
    {
      model: User,
      as: 'doctor',
      attributes: ['firstName', 'lastName'],
      include: [
        {
          model: DoctorProfile,
          attributes: ['specialty'],
        },
      ],
    },
  ];

  // If user is a patient, automatically filter to their own appointments
  if (req.user.role === 'patient') {
    const patient = await Patient.findOne({ where: { userId: req.user.id } });
    if (patient) {
      where.PatientId = patient.id;
    }
  }

  const { count, rows } = await Appointment.findAndCountAll({
    where,
    include: includes,
    order: [['date', 'DESC'], ['timeSlot', 'ASC']],
    offset,
    limit: parseInt(limit),
    distinct: true,
  });

  const appointments = rows.map(formatAppointment);

  return success(res, {
    appointments,
    pagination: {
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

/**
 * PUT /api/appointments/:id/status
 * Updates appointment status
 *
 * Request body:
 * - status: new status (scheduled, checked-in, completed, cancelled)
 *
 * Validation:
 * - For check-in: appointment must be today and currently scheduled
 *
 * Authorization: Staff, doctor, patient
 */
const VALID_STATUSES = ['scheduled', 'checked-in', 'completed', 'cancelled'];

const updateStatus = async (req, res) => {
  const { status: newStatus } = req.body;

  // Validate status value up front
  if (!newStatus) {
    return error(res, 'Status is required', 400);
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    return error(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`, 400);
  }

  const appointment = await Appointment.findByPk(req.params.id, {
    include: appointmentIncludes,
  });

  if (!appointment) {
    return error(res, 'Appointment not found', 404);
  }

  // Prevent updating a cancelled or completed appointment
  if (['cancelled', 'completed'].includes(appointment.status)) {
    return error(res, `Cannot update an appointment that is already ${appointment.status}`, 400);
  }

  // Check-in validation — must be today and currently scheduled
  if (newStatus === 'checked-in') {
    const today = new Date().toISOString().split('T')[0];
    const appointmentDate = appointment.date instanceof Date
      ? appointment.date.toISOString().split('T')[0]
      : appointment.date;
    if (appointmentDate !== today) {
      return error(res, 'Can only check-in for appointments scheduled today', 400);
    }
    if (appointment.status !== 'scheduled') {
      return error(res, 'Can only check-in scheduled appointments', 400);
    }
  }

  // Update status
  await appointment.update({ status: newStatus });

  // Re-fetch to ensure we have latest data
  const updated = await Appointment.findByPk(appointment.id, {
    include: appointmentIncludes,
  });

  const formatted = formatAppointment(updated);

  // Send cancellation emails to both patient and doctor (fire-and-forget)
  if (newStatus === 'cancelled') {
    const patient = updated.Patient;
    const doctor = updated.doctor;

    if (patient?.email) {
      sendAppointmentCancellationEmail({
        to: patient.email,
        patientName: `${patient.firstName} ${patient.lastName}`,
        doctorName: formatted.doctorName,
        date: formatted.date,
        timeSlot: formatted.timeSlot,
        appointmentType: formatted.appointmentType,
        appointmentNumber: formatted.appointmentNumber,
      }).catch(() => {});
    }

    if (doctor?.email) {
      sendDoctorAppointmentCancellationEmail({
        to: doctor.email,
        doctorName: `Dr. ${doctor.firstName} ${doctor.lastName}`,
        patientName: `${patient.firstName} ${patient.lastName}`,
        uhid: patient.uhid,
        date: formatted.date,
        timeSlot: formatted.timeSlot,
        appointmentType: formatted.appointmentType,
        appointmentNumber: formatted.appointmentNumber,
      }).catch(() => {});
    }
  }

  return success(res, formatted);
};

/**
 * GET /api/appointments/stats
 * Gets appointment statistics
 *
 * Returns:
 * - total: Total appointments
 * - scheduled: Count by status
 * - checkedIn: Count by status
 * - completed: Count by status
 * - cancelled: Count by status
 * - today: Total appointments today
 * - todayScheduled: Scheduled for today
 * - todayCheckedIn: Checked in today
 *
 * Authorization: Doctor, admin
 */
const stats = async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  // Total appointments
  const total = await Appointment.count();

  // Count by status
  const scheduled = await Appointment.count({ where: { status: 'scheduled' } });
  const checkedIn = await Appointment.count({ where: { status: 'checked-in' } });
  const completed = await Appointment.count({ where: { status: 'completed' } });
  const cancelled = await Appointment.count({ where: { status: 'cancelled' } });

  // Today's appointments
  const todayTotal = await Appointment.count({ where: { date: today } });
  const todayScheduled = await Appointment.count({
    where: { date: today, status: 'scheduled' },
  });
  const todayCheckedIn = await Appointment.count({
    where: { date: today, status: 'checked-in' },
  });

  return success(res, {
    total,
    scheduled,
    checkedIn,
    completed,
    cancelled,
    today: todayTotal,
    todayScheduled,
    todayCheckedIn,
  });
};


// EXPORTS

module.exports = {
  book,
  list,
  updateStatus,
  stats,
};
