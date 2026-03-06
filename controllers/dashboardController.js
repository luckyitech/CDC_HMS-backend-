const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

// Reuse existing utilities
const { getTodayISO, formatPatientName, formatDoctorName } = require('../utils/formatters');
const { classifyHbA1c } = require('../utils/medicalConstants');

const {
  User,
  Patient,
  Queue,
  Appointment,
  LabTest,
  Prescription,
  MedicalDocument,
  BloodSugarReading,
} = db;

// ====================================
// HELPER: Get today's date range for createdAt queries
// ====================================
const getTodayDateRange = () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  return { [Op.gte]: todayStart, [Op.lt]: tomorrowStart };
};

// ====================================
// ROLE-SPECIFIC STAT BUILDERS
// ====================================

/**
 * Admin Dashboard Stats
 */
const getAdminStats = async () => {
  const today = getTodayISO();

  // User counts by role (parallel queries)
  const [doctorCount, staffCount, labCount, patientCount, adminCount] = await Promise.all([
    User.count({ where: { role: 'doctor', isActive: true } }),
    User.count({ where: { role: 'staff', isActive: true } }),
    User.count({ where: { role: 'lab', isActive: true } }),
    Patient.count({ where: { status: 'Active' } }),
    User.count({ where: { role: 'admin', isActive: true } }),
  ]);

  // Today's activity (parallel queries)
  const todayRange = getTodayDateRange();
  const [todayAppointments, todayQueue, pendingLabTests, recentPatients] = await Promise.all([
    Appointment.count({ where: { date: today } }),
    Queue.count({ where: { createdAt: todayRange } }),
    LabTest.count({ where: { status: 'Pending' } }),
    Patient.count({ where: { createdAt: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
  ]);

  return {
    users: {
      total: doctorCount + staffCount + labCount + adminCount,
      doctors: doctorCount,
      staff: staffCount,
      labTechs: labCount,
      admins: adminCount,
    },
    patients: {
      total: patientCount,
      newThisWeek: recentPatients,
    },
    today: {
      appointments: todayAppointments,
      queueCount: todayQueue,
      pendingLabTests,
    },
  };
};

/**
 * Doctor Dashboard Stats
 */
const getDoctorStats = async (doctorId) => {
  const today = getTodayISO();

  // Get doctor's patients (assigned as primary doctor)
  const myPatientIds = await Patient.findAll({
    where: { primaryDoctorId: doctorId },
    attributes: ['id'],
  }).then(patients => patients.map(p => p.id));

  // Parallel queries for doctor stats
  const todayRange = getTodayDateRange();
  const [
    myQueueToday,
    myAppointmentsToday,
    pendingLabResults,
    activePrescriptions,
    recentConsultations,
  ] = await Promise.all([
    Queue.count({ where: { assignedDoctorId: doctorId, createdAt: todayRange, status: { [Op.ne]: 'Completed' } } }),
    Appointment.count({ where: { doctorId, date: today } }),
    LabTest.count({ where: { PatientId: { [Op.in]: myPatientIds }, status: 'Pending' } }),
    Prescription.count({ where: { doctorId, status: 'Active' } }),
    Queue.count({ where: { assignedDoctorId: doctorId, createdAt: todayRange, status: 'Completed' } }),
  ]);

  // Next patient in queue (Urgent first, then oldest arrival)
  const nextPatient = await Queue.findOne({
    where: { assignedDoctorId: doctorId, createdAt: todayRange, status: 'Waiting' },
    include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }],
    order: [['priority', 'DESC'], ['createdAt', 'ASC']],
  });

  return {
    myPatients: myPatientIds.length,
    today: {
      queueWaiting: myQueueToday,
      appointments: myAppointmentsToday,
      consultationsCompleted: recentConsultations,
    },
    pending: {
      labResults: pendingLabResults,
      activePrescriptions,
    },
    nextPatient: nextPatient ? {
      uhid: nextPatient.Patient?.uhid,
      name: formatPatientName(nextPatient.Patient),
      reason: nextPatient.reason,
      priority: nextPatient.priority,
    } : null,
  };
};

/**
 * Staff Dashboard Stats
 */
const getStaffStats = async () => {
  const today = getTodayISO();
  const todayRange = getTodayDateRange();

  const [
    queueWaiting,
    queueInTriage,
    queueWithDoctor,
    queueCompleted,
    checkInsToday,
    pendingDocuments,
    appointmentsToday,
  ] = await Promise.all([
    Queue.count({ where: { createdAt: todayRange, status: 'Waiting' } }),
    Queue.count({ where: { createdAt: todayRange, status: 'In Triage' } }),
    Queue.count({ where: { createdAt: todayRange, status: 'With Doctor' } }),
    Queue.count({ where: { createdAt: todayRange, status: 'Completed' } }),
    Queue.count({ where: { createdAt: todayRange } }),
    MedicalDocument.count({ where: { status: 'Pending Review' } }),
    Appointment.count({ where: { date: today } }),
  ]);

  // Upcoming appointments (next 3)
  const upcomingAppointments = await Appointment.findAll({
    where: { date: today, status: { [Op.ne]: 'completed' } },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
    ],
    order: [['timeSlot', 'ASC']],
    limit: 3,
  });

  return {
    queue: {
      waiting: queueWaiting,
      inTriage: queueInTriage,
      withDoctor: queueWithDoctor,
      completed: queueCompleted,
      total: checkInsToday,
    },
    today: {
      checkIns: checkInsToday,
      appointments: appointmentsToday,
    },
    pending: {
      documentsToReview: pendingDocuments,
    },
    upcomingAppointments: upcomingAppointments.map(apt => ({
      id: apt.id,
      timeSlot: apt.timeSlot,
      patient: formatPatientName(apt.Patient),
      doctor: formatDoctorName(apt.doctor),
      appointmentType: apt.appointmentType,
    })),
  };
};

/**
 * Lab Tech Dashboard Stats
 */
const getLabStats = async () => {
  const today = getTodayISO();

  const [
    pendingTests,
    inProgressTests,
    completedToday,
    urgentTests,
  ] = await Promise.all([
    LabTest.count({ where: { status: 'Pending' } }),
    LabTest.count({ where: { status: 'In Progress' } }),
    LabTest.count({ where: { status: 'Completed', completedDate: today } }),
    LabTest.count({ where: { status: 'Pending', priority: 'Urgent' } }),
  ]);

  // Recent pending tests (next 5 to process)
  const pendingTestsList = await LabTest.findAll({
    where: { status: 'Pending' },
    include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }],
    order: [
      [db.sequelize.literal("CASE WHEN priority = 'Urgent' THEN 0 ELSE 1 END"), 'ASC'],
      ['createdAt', 'ASC'],
    ],
    limit: 5,
  });

  return {
    tests: {
      pending: pendingTests,
      inProgress: inProgressTests,
      completedToday,
      urgent: urgentTests,
    },
    pendingTestsList: pendingTestsList.map(test => ({
      id: test.id,
      testType: test.testType,
      priority: test.priority,
      patient: formatPatientName(test.Patient),
      uhid: test.Patient?.uhid,
      orderedAt: test.createdAt,
    })),
  };
};

/**
 * Patient Dashboard Stats
 */
const getPatientStats = async (userId) => {
  // Find patient record linked to this user
  const patient = await Patient.findOne({
    where: { UserId: userId },
    include: [{ model: User, as: 'primaryDoctor', attributes: ['firstName', 'lastName'] }],
  });

  if (!patient) {
    return { error: 'Patient record not found' };
  }

  const today = getTodayISO();

  const [
    nextAppointment,
    recentLabTests,
    activePrescriptions,
    recentBloodSugar,
  ] = await Promise.all([
    Appointment.findOne({
      where: { PatientId: patient.id, date: { [Op.gte]: today }, status: { [Op.ne]: 'cancelled' } },
      include: [{ model: User, as: 'doctor', attributes: ['firstName', 'lastName'] }],
      order: [['date', 'ASC'], ['timeSlot', 'ASC']],
    }),
    LabTest.findAll({
      where: { PatientId: patient.id, status: 'Completed' },
      order: [['completedDate', 'DESC']],
      limit: 3,
    }),
    Prescription.count({ where: { PatientId: patient.id, status: 'Active' } }),
    BloodSugarReading.findAll({
      where: { PatientId: patient.id },
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: 5,
    }),
  ]);

  return {
    patient: {
      uhid: patient.uhid,
      name: formatPatientName(patient),
      diabetesType: patient.diabetesType,
      hba1c: patient.hba1c,
      hba1cStatus: classifyHbA1c(patient.hba1c),
      primaryDoctor: formatDoctorName(patient.primaryDoctor),
    },
    nextAppointment: nextAppointment ? {
      date: nextAppointment.date,
      timeSlot: nextAppointment.timeSlot,
      doctor: formatDoctorName(nextAppointment.doctor),
      appointmentType: nextAppointment.appointmentType,
    } : null,
    recentLabTests: recentLabTests.map(test => ({
      testType: test.testType,
      completedDate: test.completedDate,
      results: test.results,
    })),
    activePrescriptions,
    recentBloodSugar: recentBloodSugar.map(bs => ({
      date: bs.date,
      timeSlot: bs.timeSlot,
      value: bs.value,
    })),
  };
};

// ====================================
// MAIN CONTROLLER
// ====================================

/**
 * GET /api/dashboard
 * Returns role-specific dashboard statistics
 */
const getDashboard = async (req, res) => {
  const { role, id: userId } = req.user;

  try {
    let stats;

    switch (role) {
      case 'admin':
        stats = await getAdminStats();
        break;
      case 'doctor':
        stats = await getDoctorStats(userId);
        break;
      case 'staff':
        stats = await getStaffStats();
        break;
      case 'lab':
        stats = await getLabStats();
        break;
      case 'patient':
        stats = await getPatientStats(userId);
        break;
      default:
        return error(res, 'Unknown role', 400);
    }

    return success(res, {
      role,
      generatedAt: new Date().toISOString(),
      ...stats,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    return error(res, 'Failed to load dashboard. Please try again.', 500);
  }
};

module.exports = { getDashboard };
