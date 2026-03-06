const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

// Shared utilities — eliminates duplication across controllers
const {
  formatPatientName,
  formatDoctorName,
  getDaysAgo,
  getDateRange,
  calculateAverage,
} = require('../utils/formatters');

const computeAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const today = new Date();
  const dob = new Date(dateOfBirth);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
};

const {
  THRESHOLDS,
  classifyHbA1c,
  calculateRiskLevel,
  getRiskFactors,
  calculateBloodSugarStats,
} = require('../utils/medicalConstants');

const {
  Patient,
  BloodSugarReading,
  Prescription,
  LabTest,
  TreatmentPlan,
  Appointment,
  User,
} = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Find patient by UHID with optional includes
 */
const findPatientByUhid = async (uhid, includeDoctor = true) => {
  const options = { where: { uhid } };
  if (includeDoctor) {
    options.include = [{ model: User, as: 'primaryDoctor', attributes: ['firstName', 'lastName'] }];
  }
  return Patient.findOne(options);
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * GET /api/reports/types
 * Returns available report types
 */
const getReportTypes = async (req, res) => {
  try {
    const reportTypes = [
      {
        id: 'glycemic',
        name: 'Glycemic Control Report',
        description: 'Analysis of blood sugar levels and HbA1c trends',
        requiredParams: ['uhid'],
        optionalParams: ['period'],
      },
      {
        id: 'patient-summary',
        name: 'Patient Summary Report',
        description: 'Comprehensive patient health summary',
        requiredParams: ['uhid'],
        optionalParams: [],
      },
      {
        id: 'medication-adherence',
        name: 'Medication Adherence Report',
        description: 'Prescription compliance and refill patterns',
        requiredParams: ['uhid'],
        optionalParams: ['period'],
      },
      {
        id: 'high-risk-patients',
        name: 'High Risk Patients Report',
        description: 'List of patients requiring immediate attention',
        requiredParams: [],
        optionalParams: ['limit'],
      },
      {
        id: 'clinic-overview',
        name: 'Clinic Overview Report',
        description: 'Overall clinic statistics and patient outcomes',
        requiredParams: [],
        optionalParams: ['period'],
      },
    ];

    return success(res, { reportTypes });
  } catch (err) {
    console.error('Report.getReportTypes error:', err);
    return error(res, 'Failed to retrieve report types', 500);
  }
};

/**
 * GET /api/reports/glycemic
 * Glycemic control analysis for a patient
 *
 * Query params:
 * - uhid: Patient UHID (required)
 * - period: 7days, 30days, 90days, 6months, 1year (default: 30days)
 */
const getGlycemicReport = async (req, res) => {
  try {
    const { uhid, period = '30days' } = req.query;

    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }

    // Find patient
    const patient = await findPatientByUhid(uhid);
    if (!patient) {
      return error(res, `Patient ${uhid} not found`, 404);
    }

    const { startDate, endDate } = getDateRange(period);

    // Get blood sugar readings
    const bloodSugarReadings = await BloodSugarReading.findAll({
      where: {
        PatientId: patient.id,
        date: { [Op.between]: [startDate, endDate] },
      },
      order: [['date', 'ASC'], ['timeSlot', 'ASC']],
    });

    // Calculate statistics using helper
    const stats = calculateBloodSugarStats(bloodSugarReadings);

    // Get latest HbA1c from lab tests
    const latestHbA1c = await LabTest.findOne({
      where: {
        PatientId: patient.id,
        testType: { [Op.like]: '%HbA1c%' },
        status: 'Completed',
      },
      order: [['completedDate', 'DESC']],
    });

    const hba1cValue = latestHbA1c?.results?.hba1c || patient.hba1c || null;

    // Daily averages for chart
    const dailyData = {};
    bloodSugarReadings.forEach(bs => {
      if (!dailyData[bs.date]) {
        dailyData[bs.date] = { readings: [], fasting: [], postMeal: [] };
      }
      dailyData[bs.date].readings.push(parseFloat(bs.value));
      if (bs.timeSlot === 'fasting') {
        dailyData[bs.date].fasting.push(parseFloat(bs.value));
      } else if (['afterBreakfast', 'afterLunch', 'afterDinner'].includes(bs.timeSlot)) {
        dailyData[bs.date].postMeal.push(parseFloat(bs.value));
      }
    });

    const dailyAverages = Object.entries(dailyData).map(([date, data]) => ({
      date,
      average: Math.round(calculateAverage(data.readings)),
      fasting: Math.round(calculateAverage(data.fasting)) || null,
      postMeal: Math.round(calculateAverage(data.postMeal)) || null,
    }));

    return success(res, {
      report: {
        type: 'glycemic',
        generatedAt: new Date().toISOString(),
        period: { startDate, endDate, label: period },
        patient: {
          uhid: patient.uhid,
          name: formatPatientName(patient),
          age: computeAge(patient.dateOfBirth) ?? patient.age,
          diabetesType: patient.diabetesType,
          primaryDoctor: formatDoctorName(patient.primaryDoctor),
        },
        hba1c: {
          value: hba1cValue,
          classification: classifyHbA1c(hba1cValue),
          testDate: latestHbA1c?.completedDate || null,
        },
        statistics: stats,
        dailyAverages,
        recommendations: generateGlycemicRecommendations(stats, hba1cValue),
      },
    });
  } catch (err) {
    console.error('Report.getGlycemicReport error:', err);
    return error(res, 'Failed to generate glycemic report', 500);
  }
};

/**
 * Generate recommendations based on glycemic data
 */
const generateGlycemicRecommendations = (stats, hba1c) => {
  const recommendations = [];

  if (stats.hypoglycemiaEvents > 0) {
    recommendations.push({
      priority: 'High',
      category: 'Hypoglycemia',
      message: `${stats.hypoglycemiaEvents} hypoglycemia event(s) detected. Review medication dosage and meal timing.`,
    });
  }

  if (stats.hyperglycemiaEvents > stats.totalReadings * 0.3) {
    recommendations.push({
      priority: 'High',
      category: 'Hyperglycemia',
      message: 'Frequent hyperglycemia events. Consider medication adjustment or dietary review.',
    });
  }

  if (stats.timeInRange < THRESHOLDS.TIME_IN_RANGE_TARGET) {
    recommendations.push({
      priority: 'Medium',
      category: 'Time in Range',
      message: `Time in range is ${stats.timeInRange}%. Target is ${THRESHOLDS.TIME_IN_RANGE_TARGET}% or higher.`,
    });
  }

  if (hba1c && parseFloat(hba1c) >= THRESHOLDS.HBA1C_MODERATE) {
    recommendations.push({
      priority: 'High',
      category: 'HbA1c',
      message: `HbA1c of ${hba1c}% indicates poor control. Intensive management recommended.`,
    });
  }

  if (stats.averageFasting > THRESHOLDS.FASTING_TARGET) {
    recommendations.push({
      priority: 'Medium',
      category: 'Fasting Glucose',
      message: 'Fasting glucose above target. Consider overnight medication adjustment.',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'Low',
      category: 'General',
      message: 'Glycemic control is within acceptable parameters. Continue current management.',
    });
  }

  return recommendations;
};

/**
 * GET /api/reports/patient-summary
 * Comprehensive patient health summary
 *
 * Query params:
 * - uhid: Patient UHID (required)
 */
const getPatientSummary = async (req, res) => {
  try {
    const { uhid } = req.query;

    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }

    // Find patient with all related data
    const patient = await findPatientByUhid(uhid);
    if (!patient) {
      return error(res, `Patient ${uhid} not found`, 404);
    }

    // Get recent prescriptions
    const prescriptions = await Prescription.findAll({
      where: { PatientId: patient.id },
      order: [['createdAt', 'DESC']],
      limit: 10,
    });

    // Get recent lab tests
    const labTests = await LabTest.findAll({
      where: { PatientId: patient.id },
      order: [['createdAt', 'DESC']],
      limit: 10,
    });

    // Get recent blood sugar (last 7 days)
    const recentBloodSugar = await BloodSugarReading.findAll({
      where: {
        PatientId: patient.id,
        date: { [Op.gte]: getDaysAgo(7) },
      },
      order: [['date', 'DESC'], ['timeSlot', 'DESC']],
    });

    // Get active treatment plan
    const activePlan = await TreatmentPlan.findOne({
      where: { PatientId: patient.id, status: 'Active' },
      order: [['createdAt', 'DESC']],
    });

    // Get upcoming appointments
    const upcomingAppointments = await Appointment.findAll({
      where: {
        PatientId: patient.id,
        date: { [Op.gte]: new Date().toISOString().split('T')[0] },
        status: { [Op.in]: ['scheduled', 'confirmed'] },
      },
      order: [['date', 'ASC']],
      limit: 5,
    });

    // Calculate risk level
    const bloodSugarValues = recentBloodSugar.map(bs => parseFloat(bs.value));
    const riskLevel = calculateRiskLevel(patient, bloodSugarValues, parseFloat(patient.hba1c) || 0);

    return success(res, {
      report: {
        type: 'patient-summary',
        generatedAt: new Date().toISOString(),
        patient: {
          uhid: patient.uhid,
          name: formatPatientName(patient),
          age: computeAge(patient.dateOfBirth) ?? patient.age,
          gender: patient.gender,
          diabetesType: patient.diabetesType,
          diagnosisDate: patient.diagnosisDate,
          primaryDoctor: formatDoctorName(patient.primaryDoctor),
          phone: patient.phone,
          email: patient.email,
          address: patient.address,
        },
        healthMetrics: {
          hba1c: patient.hba1c,
          hba1cClassification: classifyHbA1c(patient.hba1c),
          riskLevel,
          lastVitals: patient.vitals,
          comorbidities: patient.comorbidities || [],
          allergies: patient.allergies,
        },
        recentBloodSugar: {
          count: recentBloodSugar.length,
          average: Math.round(calculateAverage(bloodSugarValues)),
          readings: recentBloodSugar.slice(0, 5).map(bs => ({
            date: bs.date,
            timeSlot: bs.timeSlot,
            value: bs.value,
          })),
        },
        medications: {
          activePrescriptions: prescriptions.filter(p => p.status === 'Active').length,
          recentPrescriptions: prescriptions.slice(0, 5).map(p => ({
            id: p.id,
            date: p.date,
            diagnosis: p.diagnosis,
            status: p.status,
            medicationCount: p.medications?.length || 0,
          })),
        },
        labTests: {
          totalTests: labTests.length,
          pendingTests: labTests.filter(t => t.status === 'Pending').length,
          recentTests: labTests.slice(0, 5).map(t => ({
            id: t.id,
            testType: t.testType,
            status: t.status,
            orderedAt: t.createdAt,
            completedDate: t.completedDate,
          })),
        },
        treatmentPlan: activePlan ? {
          diagnosis: activePlan.diagnosis,
          plan: activePlan.plan,
          status: activePlan.status,
          createdAt: activePlan.createdAt,
        } : null,
        upcomingAppointments: upcomingAppointments.map(a => ({
          id: a.id,
          date: a.date,
          time: a.time,
          type: a.appointmentType,
          status: a.status,
        })),
      },
    });
  } catch (err) {
    console.error('Report.getPatientSummary error:', err);
    return error(res, 'Failed to generate patient summary', 500);
  }
};

/**
 * GET /api/reports/medication-adherence
 * Medication adherence report for a patient
 *
 * Query params:
 * - uhid: Patient UHID (required)
 * - period: 30days, 90days, 6months, 1year (default: 90days)
 */
const getMedicationAdherence = async (req, res) => {
  try {
    const { uhid, period = '90days' } = req.query;

    if (!uhid) {
      return error(res, 'Patient UHID is required', 400);
    }

    const patient = await findPatientByUhid(uhid, false);
    if (!patient) {
      return error(res, `Patient ${uhid} not found`, 404);
    }

    const { startDate, endDate } = getDateRange(period);

    // Get prescriptions in period
    const prescriptions = await Prescription.findAll({
      where: {
        PatientId: patient.id,
        createdAt: { [Op.between]: [startDate, endDate] },
      },
      order: [['createdAt', 'DESC']],
    });

    // Calculate adherence metrics
    const totalPrescriptions = prescriptions.length;
    const completedPrescriptions = prescriptions.filter(p => p.status === 'Completed').length;
    const activePrescriptions = prescriptions.filter(p => p.status === 'Active').length;
    const expiredPrescriptions = prescriptions.filter(p => p.status === 'Expired').length;

    // Analyze medication patterns
    const medicationFrequency = {};
    prescriptions.forEach(p => {
      (p.medications || []).forEach(med => {
        const name = med.name || 'Unknown';
        if (!medicationFrequency[name]) {
          medicationFrequency[name] = { count: 0, prescriptions: [] };
        }
        medicationFrequency[name].count++;
        medicationFrequency[name].prescriptions.push({
          date: p.date,
          dosage: med.dosage,
          frequency: med.frequency,
        });
      });
    });

    const topMedications = Object.entries(medicationFrequency)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([name, data]) => ({ name, ...data }));

    // Calculate adherence score (simplified)
    const adherenceScore = totalPrescriptions > 0
      ? Math.round(((completedPrescriptions + activePrescriptions) / totalPrescriptions) * 100)
      : 100;

    return success(res, {
      report: {
        type: 'medication-adherence',
        generatedAt: new Date().toISOString(),
        period: { startDate, endDate, label: period },
        patient: {
          uhid: patient.uhid,
          name: formatPatientName(patient),
        },
        summary: {
          totalPrescriptions,
          activePrescriptions,
          completedPrescriptions,
          expiredPrescriptions,
          adherenceScore,
          adherenceLevel: adherenceScore >= 80 ? 'Good' : adherenceScore >= 60 ? 'Moderate' : 'Poor',
        },
        topMedications,
        prescriptionHistory: prescriptions.slice(0, 10).map(p => ({
          id: p.id,
          date: p.date,
          diagnosis: p.diagnosis,
          status: p.status,
          medications: p.medications,
        })),
      },
    });
  } catch (err) {
    console.error('Report.getMedicationAdherence error:', err);
    return error(res, 'Failed to generate medication adherence report', 500);
  }
};

/**
 * GET /api/reports/high-risk-patients
 * List of high-risk patients requiring attention
 *
 * Query params:
 * - limit: Number of patients to return (default: 20)
 */
const getHighRiskPatients = async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Get all active patients
    const patients = await Patient.findAll({
      where: { status: 'Active' },
      include: [{ model: User, as: 'primaryDoctor', attributes: ['firstName', 'lastName'] }],
    });

    // Batch fetch all blood sugar readings for the last 7 days (fixes N+1 query)
    const patientIds = patients.map(p => p.id);
    const sevenDaysAgoDate = getDaysAgo(7);

    const allRecentBloodSugar = await BloodSugarReading.findAll({
      where: {
        PatientId: { [Op.in]: patientIds },
        date: { [Op.gte]: sevenDaysAgoDate },
      },
    });

    // Group blood sugar readings by patient ID
    const bloodSugarByPatient = {};
    allRecentBloodSugar.forEach(bs => {
      if (!bloodSugarByPatient[bs.PatientId]) {
        bloodSugarByPatient[bs.PatientId] = [];
      }
      bloodSugarByPatient[bs.PatientId].push(parseFloat(bs.value));
    });

    // Calculate risk for each patient (no additional queries needed)
    const patientsWithRisk = patients.map((patient) => {
      const bloodSugarValues = bloodSugarByPatient[patient.id] || [];
      const riskLevel = calculateRiskLevel(patient, bloodSugarValues, parseFloat(patient.hba1c) || 0);
      const riskFactors = getRiskFactors(patient, bloodSugarValues);

      return {
        uhid: patient.uhid,
        name: formatPatientName(patient),
        age: patient.age,
        diabetesType: patient.diabetesType,
        hba1c: patient.hba1c,
        riskLevel,
        riskFactors,
        primaryDoctor: formatDoctorName(patient.primaryDoctor),
        lastVisit: patient.lastVisitDate,
        recentBloodSugarAvg: bloodSugarValues.length ? Math.round(calculateAverage(bloodSugarValues)) : null,
      };
    });

    // Filter and sort by risk
    const riskOrder = { High: 0, Medium: 1, Low: 2 };
    const highRiskPatients = patientsWithRisk
      .filter(p => p.riskLevel === 'High' || p.riskLevel === 'Medium')
      .sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel])
      .slice(0, parseInt(limit));

    return success(res, {
      report: {
        type: 'high-risk-patients',
        generatedAt: new Date().toISOString(),
        summary: {
          totalPatients: patients.length,
          highRiskCount: patientsWithRisk.filter(p => p.riskLevel === 'High').length,
          mediumRiskCount: patientsWithRisk.filter(p => p.riskLevel === 'Medium').length,
          lowRiskCount: patientsWithRisk.filter(p => p.riskLevel === 'Low').length,
        },
        patients: highRiskPatients,
      },
    });
  } catch (err) {
    console.error('Report.getHighRiskPatients error:', err);
    return error(res, 'Failed to generate high-risk patients report', 500);
  }
};

/**
 * GET /api/reports/clinic-overview
 * Overall clinic statistics
 *
 * Query params:
 * - period: 7days, 30days, 90days (default: 30days)
 */
const getClinicOverview = async (req, res) => {
  try {
    const { period = '30days' } = req.query;
    const { startDate, endDate } = getDateRange(period);

    // Patient statistics
    const totalPatients = await Patient.count();
    const activePatients = await Patient.count({ where: { status: 'Active' } });
    const newPatients = await Patient.count({
      where: { createdAt: { [Op.between]: [startDate, endDate] } },
    });

    // Appointment statistics
    const totalAppointments = await Appointment.count({
      where: { date: { [Op.between]: [startDate, endDate] } },
    });
    const completedAppointments = await Appointment.count({
      where: {
        date: { [Op.between]: [startDate, endDate] },
        status: 'completed',
      },
    });
    const cancelledAppointments = await Appointment.count({
      where: {
        date: { [Op.between]: [startDate, endDate] },
        status: 'cancelled',
      },
    });

    // Lab test statistics
    const totalLabTests = await LabTest.count({
      where: { createdAt: { [Op.between]: [startDate, endDate] } },
    });
    const completedLabTests = await LabTest.count({
      where: {
        createdAt: { [Op.between]: [startDate, endDate] },
        status: 'Completed',
      },
    });
    const criticalResults = await LabTest.count({
      where: {
        createdAt: { [Op.between]: [startDate, endDate] },
        isCritical: true,
      },
    });

    // Prescription statistics
    const totalPrescriptions = await Prescription.count({
      where: { createdAt: { [Op.between]: [startDate, endDate] } },
    });

    // HbA1c distribution
    const allPatients = await Patient.findAll({
      where: { status: 'Active' },
      attributes: ['hba1c'],
    });
    const hba1cDistribution = {
      wellControlled: allPatients.filter(p => parseFloat(p.hba1c) < THRESHOLDS.HBA1C_WELL_CONTROLLED).length,
      moderatelyControlled: allPatients.filter(p => {
        const val = parseFloat(p.hba1c);
        return val >= THRESHOLDS.HBA1C_WELL_CONTROLLED && val < THRESHOLDS.HBA1C_MODERATE;
      }).length,
      poorlyControlled: allPatients.filter(p => parseFloat(p.hba1c) >= THRESHOLDS.HBA1C_MODERATE).length,
      unknown: allPatients.filter(p => !p.hba1c).length,
    };

    return success(res, {
      report: {
        type: 'clinic-overview',
        generatedAt: new Date().toISOString(),
        period: { startDate, endDate, label: period },
        patients: {
          total: totalPatients,
          active: activePatients,
          newInPeriod: newPatients,
        },
        appointments: {
          total: totalAppointments,
          completed: completedAppointments,
          cancelled: cancelledAppointments,
          completionRate: totalAppointments > 0
            ? Math.round((completedAppointments / totalAppointments) * 100)
            : 0,
        },
        labTests: {
          total: totalLabTests,
          completed: completedLabTests,
          criticalResults,
          completionRate: totalLabTests > 0
            ? Math.round((completedLabTests / totalLabTests) * 100)
            : 0,
        },
        prescriptions: {
          total: totalPrescriptions,
        },
        glycemicControl: {
          distribution: hba1cDistribution,
          percentWellControlled: activePatients > 0
            ? Math.round((hba1cDistribution.wellControlled / activePatients) * 100)
            : 0,
        },
      },
    });
  } catch (err) {
    console.error('Report.getClinicOverview error:', err);
    return error(res, 'Failed to generate clinic overview report', 500);
  }
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  getReportTypes,
  getGlycemicReport,
  getPatientSummary,
  getMedicationAdherence,
  getHighRiskPatients,
  getClinicOverview,
};
