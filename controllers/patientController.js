const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { generateUHID } = require('../utils/generateId');
const { sendPatientWelcomeEmail } = require('../utils/emailService');

const { Patient, User, PatientVital } = db;

// ------------------------------------
// Helpers
// ------------------------------------

// Formats a PatientVital row into the response shape with units.
const formatVitals = (vital) => {
  if (!vital) return null;
  return {
    bp:                vital.bp               !== null && vital.bp               !== undefined ? `${vital.bp} mmHg`           : null,
    heartRate:         vital.heartRate        !== null && vital.heartRate        !== undefined ? `${vital.heartRate} bpm`     : null,
    weight:            vital.weight           !== null && vital.weight           !== undefined ? `${vital.weight} kg`         : null,
    height:            vital.height           !== null && vital.height           !== undefined ? `${vital.height} cm`         : null,
    bmi:               vital.bmi              !== null && vital.bmi              !== undefined ? `${vital.bmi}`                : null,
    temperature:       vital.temperature      !== null && vital.temperature      !== undefined ? `${vital.temperature}°C`     : null,
    oxygenSaturation:  vital.oxygenSaturation !== null && vital.oxygenSaturation !== undefined ? `${vital.oxygenSaturation}%` : null,
    waistCircumference: vital.waistCircumference !== null && vital.waistCircumference !== undefined ? `${vital.waistCircumference} cm` : null,
    waistHeightRatio:  vital.waistHeightRatio  !== null && vital.waistHeightRatio  !== undefined ? `${vital.waistHeightRatio}`  : null,
    rbs:               vital.rbs               !== null && vital.rbs               !== undefined ? `${vital.rbs} mmol/L`        : null,
    hba1c:             vital.hba1c             !== null && vital.hba1c             !== undefined ? `${vital.hba1c}%`             : null,
    ketones:           vital.ketones           !== null && vital.ketones           !== undefined ? `${vital.ketones} mmol/L`     : null,
    chiefComplaint:    vital.chiefComplaint    || null,
    recordedAt:        vital.recordedAt || null,
  };
};

// Compute age from dateOfBirth — always accurate, no stale DB value
const computeAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const today = new Date();
  const dob = new Date(dateOfBirth);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
};

// Shapes a Patient row (with primaryDoctor included) into the full API response.
const formatPatient = (patient, latestVital) => {
  const p = patient.dataValues || patient;
  return {
    id:               p.id,
    uhid:             p.uhid,
    name:             `${p.firstName} ${p.lastName}`,
    age:              computeAge(p.dateOfBirth) ?? p.age,
    gender:           p.gender,
    phone:            p.phone,
    email:            p.email,
    address:          p.address,
    dateOfBirth:      p.dateOfBirth,
    idNumber:         p.idNumber,
    diabetesType:     p.diabetesType,
    diagnosisDate:    p.diagnosisDate,
    hba1c:            p.hba1c,
    primaryDoctor:    p.primaryDoctor
                        ? `Dr. ${p.primaryDoctor.firstName} ${p.primaryDoctor.lastName}`
                        : null,
    referredBy:       p.referredBy,
    status:           p.status,
    riskLevel:        p.riskLevel,
    lastVisit:        p.lastVisit,
    nextVisit:        p.nextVisit,
    emergencyContact: p.emergencyContact,
    insurance:        p.insurance,
    vitals:           formatVitals(latestVital),
    medications:      p.currentMedications,
    allergies:        p.allergies,
    comorbidities:    p.comorbidities,
  };
};

// Reusable include for joining the assigned primary doctor's name.
const doctorInclude = {
  model: User,
  as: 'primaryDoctor',
  attributes: ['firstName', 'lastName'],
};

// ------------------------------------
// POST /api/patients — create patient
// Always creates both a patient record AND a user login account.
// ------------------------------------
const create = async (req, res) => {
  const { password, ...patientFields } = req.body;

  // Use provided UHID or auto-generate one
  let uhid = patientFields.uhid;
  if (uhid) {
    const existing = await Patient.findOne({ where: { uhid } });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `UHID "${uhid}" already exists. Please use a different UHID.`,
      });
    }
  } else {
    uhid = await generateUHID(Patient);
  }

  // Use provided password or auto-generate one
  const tempPassword = password || crypto.randomBytes(6).toString('hex');

  const transaction = await sequelize.transaction();
  try {
    // Check if email already has a user account
    if (patientFields.email) {
      const existingUser = await User.findOne({ where: { email: patientFields.email } });
      if (existingUser) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `A login account already exists for email "${patientFields.email}".`,
        });
      }
    }

    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    const user = await User.create({
      email: patientFields.email,
      password: hashedPassword,
      role: 'patient',
      firstName: patientFields.firstName,
      lastName: patientFields.lastName,
      phone: patientFields.phone,
      isActive: true,
    }, { transaction });

    const patient = await Patient.create({ ...patientFields, uhid, UserId: user.id }, { transaction });
    await transaction.commit();

    const full = await Patient.findByPk(patient.id, { include: [doctorInclude] });

    // Send welcome email to patient with login credentials
    if (patientFields.email) {
      sendPatientWelcomeEmail({
        to: patientFields.email,
        name: `${patientFields.firstName} ${patientFields.lastName}`,
        uhid,
        tempPassword,
      }).catch(() => {});
    }

    // Return tempPassword so the frontend can show it to the staff member
    return success(res, { ...formatPatient(full, null), tempPassword }, 201);
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// ------------------------------------
// GET /api/patients — list with search / filters / pagination
// ------------------------------------
const list = async (req, res) => {
  const { search, doctor, riskLevel, status, page = 1, limit = 20 } = req.query;

  const where   = {};
  const include = [{ ...doctorInclude }]; // default: left join, no filter

  // Full-text search across name, uhid, phone, email (OR)
  if (search) {
    where[Op.or] = [
      { firstName: { [Op.like]: `%${search}%` } },
      { lastName:  { [Op.like]: `%${search}%` } },
      { uhid:      { [Op.like]: `%${search}%` } },
      { phone:     { [Op.like]: `%${search}%` } },
      { email:     { [Op.like]: `%${search}%` } },
    ];
  }

  // Filter by primary doctor name — turns the join into INNER + where
  if (doctor) {
    include[0] = {
      ...doctorInclude,
      required: true,
      where: {
        [Op.or]: [
          { firstName: { [Op.like]: `%${doctor}%` } },
          { lastName:  { [Op.like]: `%${doctor}%` } },
        ],
      },
    };
  }

  if (riskLevel) where.riskLevel = riskLevel;
  if (status)    where.status    = status;

  const offset = (parseInt(page) - 1) * parseInt(limit);

  const { count, rows } = await Patient.findAndCountAll({
    where,
    include,
    order:    [['id', 'ASC']],
    offset,
    limit:    parseInt(limit),
    distinct: true, // count unique patients, not joined rows
  });

  // Bulk-fetch latest vitals for every patient on this page in one query
  const patientIds = rows.map(p => p.id);
  const vitals     = await PatientVital.findAll({
    where: { PatientId: patientIds },
    order: [['recordedAt', 'DESC']],
  });

  // Keep only the first (most-recent) vital per patient
  const vitalMap = {};
  vitals.forEach(v => {
    if (!vitalMap[v.PatientId]) vitalMap[v.PatientId] = v;
  });

  const patients = rows.map(p => formatPatient(p, vitalMap[p.id] || null));

  return success(res, {
    patients,
    pagination: {
      total:      count,
      page:       parseInt(page),
      limit:      parseInt(limit),
      totalPages: Math.ceil(count / parseInt(limit)),
    },
  });
};

// ------------------------------------
// GET /api/patients/:uhid — single patient
// ------------------------------------
const getOne = async (req, res) => {
  const patient = await Patient.findByPk(req.patient.id, { include: [doctorInclude] });

  const latestVital = await PatientVital.findOne({
    where: { PatientId: req.patient.id },
    order: [['recordedAt', 'DESC']],
  });

  return success(res, formatPatient(patient, latestVital));
};

// ------------------------------------
// PUT /api/patients/:uhid — update patient
// ------------------------------------
const update = async (req, res) => {
  await req.patient.update(req.body);

  // Re-fetch full response
  const full = await Patient.findByPk(req.patient.id, { include: [doctorInclude] });
  const latestVital = await PatientVital.findOne({
    where: { PatientId: req.patient.id },
    order: [['recordedAt', 'DESC']],
  });

  return success(res, formatPatient(full, latestVital));
};

// ------------------------------------
// DELETE /api/patients/:uhid — delete patient
// ------------------------------------
const destroy = async (req, res) => {
  await req.patient.destroy();
  return success(res, { message: 'Patient deleted successfully' });
};

// ------------------------------------
// GET /api/patients/stats — aggregate counts
// ------------------------------------
const stats = async (req, res) => {
  const [total, active, inactive, highRisk, mediumRisk, lowRisk, type1, type2] =
    await Promise.all([
      Patient.count(),
      Patient.count({ where: { status:      'Active'   } }),
      Patient.count({ where: { status:      'Inactive' } }),
      Patient.count({ where: { riskLevel:   'High'     } }),
      Patient.count({ where: { riskLevel:   'Medium'   } }),
      Patient.count({ where: { riskLevel:   'Low'      } }),
      Patient.count({ where: { diabetesType: 'Type 1'  } }),
      Patient.count({ where: { diabetesType: 'Type 2'  } }),
    ]);

  return success(res, { total, active, inactive, highRisk, mediumRisk, lowRisk, type1, type2 });
};

// ------------------------------------
// POST /api/patients/:uhid/vitals — record triage vitals
// ------------------------------------
const recordVitals = async (req, res) => {
  const { weight, height, waistCircumference } = req.body;

  // Auto-calculate derived fields
  const bmi = (weight && height)
    ? parseFloat((weight / Math.pow(height / 100, 2)).toFixed(1))
    : null;

  const waistHeightRatio = (waistCircumference && height)
    ? parseFloat((waistCircumference / height).toFixed(2))
    : null;

  const vital = await PatientVital.create({
    ...req.body,
    PatientId: req.patient.id,
    bmi,
    waistHeightRatio,
  });

  return success(res, formatVitals(vital), 201);
};

// ------------------------------------
// GET /api/patients/:uhid/vitals — latest vitals
// ------------------------------------
const getVitals = async (req, res) => {
  const latestVital = await PatientVital.findOne({
    where: { PatientId: req.patient.id },
    order: [['recordedAt', 'DESC']],
  });

  return success(res, formatVitals(latestVital));
};

module.exports = { create, list, getOne, update, destroy, stats, recordVitals, getVitals };
