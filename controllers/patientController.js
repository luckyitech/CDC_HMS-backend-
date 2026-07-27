const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');
const { resolvePatient } = require('../utils/patientFamily');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { generateUHID } = require('../utils/generateId');
const { sendPatientWelcomeEmail, sendEmailUpdatedEmail } = require('../utils/emailService');

const {
  Patient, User, PatientVital, Appointment, Queue,
  BloodSugarReading, Prescription, LabTest, TreatmentPlan,
  PhysicalExamination, InitialAssessment, ConsultationNote,
  MedicalDocument, MedicalEquipment, EquipmentHistory, EquipmentAuditLog,
  CareLinkPartner,
} = db;

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
const formatPatient = (patient, latestVital, nextAppointment = null, lastQueue = null) => {
  const p = patient.dataValues || patient;

  // Derive last visit date from the most recent completed queue entry
  const lastVisitDate = lastQueue
    ? new Date(lastQueue.createdAt).toISOString().split('T')[0]
    : p.lastVisit || null;

  return {
    id:               p.id,
    uhid:             p.uhid,
    name:             `${p.firstName} ${p.lastName}`,
    age:              computeAge(p.dateOfBirth),
    gender:           p.gender,
    phone:            p.phone,
    email:            p.email,
    address:          p.address,
    dateOfBirth:      p.dateOfBirth,
    idNumber:         p.idNumber,
    diagnosis:        p.diagnosis,
    diagnosisDate:    p.diagnosisDate,
    hba1c:            p.hba1c,
    primaryDoctor:    p.primaryDoctor
                        ? `Dr. ${p.primaryDoctor.firstName} ${p.primaryDoctor.lastName}`
                        : null,
    referredBy:       p.referredBy,
    status:           p.status,
    riskLevel:        p.riskLevel,
    lastVisit:        lastVisitDate,
    nextVisit:        nextAppointment?.date      || p.nextVisit  || null,
    nextVisitBooked:  nextAppointment?.bookedAt  || null,
    emergencyContact: p.emergencyContact,
    insurance:        p.insurance,
    vitals:           formatVitals(latestVital),
    medications:      p.currentMedications,
    allergies:        p.allergies,
    comorbidities:    p.comorbidities,
    patientSummary:   p.patientSummary   || null,
    summaryUpdatedBy: p.summaryUpdatedBy || null,
    summaryUpdatedAt: p.summaryUpdatedAt || null,
    registeredBy:         p.registeredBy         || null,
    hasPortalAccount:     !!p.UserId,
    registrationComplete: !!p.registrationComplete,
    mergedIntoUhid:       p.mergedInto?.uhid || null,
  };
};

// Reusable include for joining the assigned primary doctor's name.
const doctorInclude = {
  model: User,
  as: 'primaryDoctor',
  attributes: ['firstName', 'lastName'],
};

// Reusable include for resolving the canonical patient a deactivated patient was merged into.
const mergedIntoInclude = {
  model:      Patient,
  as:         'mergedInto',
  attributes: ['uhid'],
};

// ------------------------------------
// PRIVATE HELPERS
// ------------------------------------

// Returns the conflicting patient if idNumber is already taken by a different record, else null.
// Pass excludeId (Patient PK) when updating so the patient's own ID doesn't trigger a false positive.
const findDuplicateIdNumber = (idNumber, excludeId = null) => {
  if (!idNumber) return Promise.resolve(null);
  const where = { idNumber };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return Patient.findOne({ where, attributes: ['uhid', 'firstName', 'lastName'] });
};

// Builds the standard 409 response used whenever a duplicate ID number is detected.
const duplicateIdResponse = (res, idNumber, existing) =>
  res.status(409).json({
    success: false,
    message: `A patient with this ID number / Passport / Birth certificate number already exists.`,
    existingPatient: { uhid: existing.uhid, name: `${existing.firstName} ${existing.lastName}`.trim() },
  });

/**
 * Fetches the full patient row with all related data needed for an API response.
 * Centralises the repeated Promise.all pattern across create / update / completeRegistration.
 */
const fetchFullPatient = (patientId) => {
  const today = new Date().toISOString().split('T')[0];
  return Promise.all([
    Patient.findByPk(patientId, { include: [doctorInclude, mergedIntoInclude] }),
    PatientVital.findOne({
      where: { PatientId: patientId },
      order: [['recordedAt', 'DESC']],
    }),
    Appointment.findOne({
      where: { PatientId: patientId, status: 'scheduled', date: { [Op.gte]: today } },
      order: [['date', 'ASC']],
      attributes: ['PatientId', 'date', 'bookedAt'],
    }),
    Queue.findOne({
      where: { PatientId: patientId, status: 'Completed' },
      order: [['createdAt', 'DESC']],
      attributes: ['PatientId', 'createdAt'],
    }),
  ]);
};

/**
 * Syncs the linked User account when patient profile fields change.
 * - Mirrors firstName / lastName / phone changes to the User row.
 * - If email is being set for the first time, generates credentials and returns tempPassword.
 * - Validates email uniqueness before applying any change.
 *
 * Returns the tempPassword string if a new email was activated, otherwise null.
 * Throws { statusCode: 400, message } on email conflict so the caller can return a clean HTTP error.
 */
const syncLinkedUser = async (userId, fields, password) => {
  if (!userId) return { tempPassword: null, emailChanged: false };

  const user = await User.findByPk(userId);
  if (!user) return { tempPassword: null, emailChanged: false };

  const updates = {};
  let emailChanged = false;

  if (fields.firstName !== undefined) updates.firstName = fields.firstName;
  if (fields.lastName  !== undefined) updates.lastName  = fields.lastName;
  if (fields.phone     !== undefined) updates.phone     = fields.phone;

  if (fields.email !== undefined && fields.email !== user.email) {
    if (fields.email) {
      const conflict = await User.findOne({
        where: { email: fields.email, id: { [Op.ne]: user.id } },
      });
      if (conflict) {
        const err = new Error(`A login account already exists for email "${fields.email}".`);
        err.statusCode = 400;
        throw err;
      }
    }
    updates.email = fields.email || null;
    emailChanged = true;
  }

  // First time an email is being added to an existing User — activate with a password
  const activatingAccount = fields.email && !user.email;
  let tempPassword = null;
  if (activatingAccount) {
    tempPassword = password || crypto.randomBytes(6).toString('hex');
    updates.password = await bcrypt.hash(tempPassword, 10);
  }

  if (Object.keys(updates).length > 0) {
    await user.update(updates);
  }

  return { tempPassword, emailChanged };
};

// ------------------------------------
// POST /api/patients — create patient
// Always creates both a patient record AND a user login account.
// ------------------------------------
// Phone and emergency contact are mandatory to register a patient.
// Returns an error message string, or null when the required fields are present.
const missingContactInfo = (fields) => {
  if (!fields.phone || !String(fields.phone).trim()) {
    return 'Phone number is required.';
  }
  const ec = fields.emergencyContact;
  if (!ec || !String(ec.name || '').trim() || !String(ec.relationship || '').trim() || !String(ec.phone || '').trim()) {
    return 'Emergency contact name, relationship, and phone are all required.';
  }
  return null;
};

const create = async (req, res) => {
  const { password, ...patientFields } = req.body;

  const contactError = missingContactInfo(patientFields);
  if (contactError) {
    return res.status(400).json({ success: false, message: contactError });
  }

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

  const idDuplicate = await findDuplicateIdNumber(patientFields.idNumber);
  if (idDuplicate) return duplicateIdResponse(res, patientFields.idNumber, idDuplicate);

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

    const patient = await Patient.create({ ...patientFields, uhid, UserId: user.id, registrationComplete: true, registeredBy: req.user.name || 'Unknown', registeredByRole: req.user.role || 'staff' }, { transaction });
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
// POST /api/patients/quick — minimal placeholder for phone bookings
// Creates a Patient record only (no User login account).
// Full profile is completed face-to-face when the patient walks in.
// ------------------------------------
const quickCreate = async (req, res) => {
  const { firstName, lastName, phone } = req.body;

  if (!phone || !phone.trim()) {
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  try {
    const existing = await Patient.findOne({ where: { phone } });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `A patient with phone ${phone} already exists — ${existing.firstName} ${existing.lastName} (${existing.uhid}).`,
      });
    }

    const uhid = await generateUHID(Patient);

    const patient = await Patient.create({
      firstName,
      lastName,
      phone,
      uhid,
      registeredBy:     req.user.name || 'Unknown',
      registeredByRole: req.user.role || 'staff',
    });

    return success(res, formatPatient(patient, null), 201);
  } catch (err) {
    console.error('quickCreate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to register patient' });
  }
};

// ------------------------------------
// GET /api/patients — list with search / filters / pagination
// ------------------------------------
const list = async (req, res) => {
  const { search, doctor, riskLevel, status, page = 1, limit = 20 } = req.query;

  const where   = {};
  const include = [{ ...doctorInclude }]; // default: left join, no filter

  // Full-text search across name, uhid, phone, email, idNumber (OR)
  if (search) {
    where[Op.or] = [
      { firstName: { [Op.like]: `%${search}%` } },
      { lastName:  { [Op.like]: `%${search}%` } },
      { uhid:      { [Op.like]: `%${search}%` } },
      { phone:     { [Op.like]: `%${search}%` } },
      { email:     { [Op.like]: `%${search}%` } },
      { idNumber:  { [Op.like]: `%${search}%` } },
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

  const patientIds = rows.map(p => p.id);
  const today      = new Date().toISOString().split('T')[0];

  // Bulk-fetch vitals, next scheduled appointments, and last completed queue visits in parallel
  const [vitals, nextAppts, lastQueues] = await Promise.all([
    PatientVital.findAll({
      where: { PatientId: patientIds },
      order: [['recordedAt', 'DESC']],
    }),
    Appointment.findAll({
      where: {
        PatientId: patientIds,
        status:    'scheduled',
        date:      { [Op.gte]: today },
      },
      order:      [['date', 'ASC']],
      attributes: ['PatientId', 'date', 'bookedAt'],
    }),
    Queue.findAll({
      where: {
        PatientId: patientIds,
        status:    'Completed',
      },
      order:      [['createdAt', 'DESC']],
      attributes: ['PatientId', 'createdAt'],
    }),
  ]);

  // Keep only the most-recent vital per patient
  const vitalMap = {};
  vitals.forEach(v => {
    if (!vitalMap[v.PatientId]) vitalMap[v.PatientId] = v;
  });

  // Keep only the earliest upcoming appointment per patient
  const nextApptMap = {};
  nextAppts.forEach(a => {
    if (!nextApptMap[a.PatientId]) nextApptMap[a.PatientId] = a;
  });

  // Keep only the most recent completed queue visit per patient
  const lastQueueMap = {};
  lastQueues.forEach(q => {
    if (!lastQueueMap[q.PatientId]) lastQueueMap[q.PatientId] = q;
  });

  const patients = rows.map(p => formatPatient(
    p,
    vitalMap[p.id]     || null,
    nextApptMap[p.id]  || null,
    lastQueueMap[p.id] || null,
  ));

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
  const [patient, latestVital, nextAppt, lastQueue] = await fetchFullPatient(req.patient.id);
  return success(res, formatPatient(patient, latestVital, nextAppt, lastQueue));
};

// ------------------------------------
// POST /api/patients/:uhid/complete-registration
// Completes a quick-registered (phone booking) patient's profile.
// Updates all fields and, if email is provided, creates the portal login account.
// ------------------------------------
const completeRegistration = async (req, res) => {
  const patient = req.patient;

  if (patient.registrationComplete) {
    return res.status(400).json({ success: false, message: 'Registration has already been completed for this patient.' });
  }

  const { password, ...patientFields } = req.body;

  const contactError = missingContactInfo(patientFields);
  if (contactError) {
    return res.status(400).json({ success: false, message: contactError });
  }

  const idDuplicate = await findDuplicateIdNumber(patientFields.idNumber, patient.id);
  if (idDuplicate) return duplicateIdResponse(res, patientFields.idNumber, idDuplicate);

  const transaction = await sequelize.transaction();
  try {
    let tempPassword = null;

    if (patientFields.email) {
      const existingUser = await User.findOne({ where: { email: patientFields.email } });
      if (existingUser) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `A login account already exists for email "${patientFields.email}".`,
        });
      }

      tempPassword = password || crypto.randomBytes(6).toString('hex');
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      const user = await User.create({
        email:     patientFields.email,
        password:  hashedPassword,
        role:      'patient',
        firstName: patient.firstName,
        lastName:  patient.lastName,
        phone:     patientFields.phone || patient.phone,
        isActive:  true,
      }, { transaction });

      await patient.update({ ...patientFields, UserId: user.id, registrationComplete: true }, { transaction });
    } else {
      await patient.update({ ...patientFields, registrationComplete: true }, { transaction });
    }

    await transaction.commit();

    if (patientFields.email && tempPassword) {
      sendPatientWelcomeEmail({
        to:   patientFields.email,
        name: `${patient.firstName} ${patient.lastName}`,
        uhid: patient.uhid,
        tempPassword,
      }).catch(() => {});
    }

    const [full, latestVital, nextAppt, lastQueue] = await fetchFullPatient(patient.id);

    return success(res, {
      ...formatPatient(full, latestVital, nextAppt, lastQueue),
      ...(tempPassword ? { tempPassword } : {}),
    });
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// ------------------------------------
// PUT /api/patients/:uhid — update patient
// Two cases:
//   A) Patient has no portal account yet but an email is now provided → create User + link
//   B) Patient already has a portal account → update fields and sync the linked User
// ------------------------------------
const update = async (req, res) => {
  if (req.isDeactivated) {
    return res.status(403).json({ success: false, message: 'This patient profile is inactive. Use reactivate to restore it first.' });
  }
  // registrationComplete is managed exclusively by completeRegistration / create — never editable here
  const { password, registrationComplete: _rc, ...patientFields } = req.body;
  const patient = req.patient;

  let tempPassword = null;

  console.log(`[update] UHID=${patient.uhid} UserId=${patient.UserId} newEmail=${patientFields.email}`);

  const idDuplicate = await findDuplicateIdNumber(patientFields.idNumber, patient.id);
  if (idDuplicate) return duplicateIdResponse(res, patientFields.idNumber, idDuplicate);

  if (!patient.UserId && patientFields.email) {
    // Case A: first-time email — create a portal account and link it atomically
    const conflict = await User.findOne({ where: { email: patientFields.email } });
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: `A login account already exists for email "${patientFields.email}".`,
      });
    }

    tempPassword = password || crypto.randomBytes(6).toString('hex');
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const transaction = await sequelize.transaction();
    try {
      const user = await User.create({
        email:     patientFields.email,
        password:  hashedPassword,
        role:      'patient',
        firstName: patientFields.firstName ?? patient.firstName,
        lastName:  patientFields.lastName  ?? patient.lastName,
        phone:     patientFields.phone     ?? patient.phone,
        isActive:  true,
      }, { transaction });

      await patient.update({ ...patientFields, UserId: user.id, registrationComplete: true }, { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    console.log(`[update] Case A — sending welcome email to ${patientFields.email}`);
    sendPatientWelcomeEmail({
      to:          patientFields.email,
      name:        `${patientFields.firstName ?? patient.firstName} ${patientFields.lastName ?? patient.lastName}`,
      uhid:        patient.uhid,
      tempPassword,
    }).catch(err => console.error('[update] Welcome email failed:', err.message));
  } else {
    // Case B: standard update — persist fields and sync any linked User
    await patient.update(patientFields);

    let emailChanged = false;
    try {
      ({ tempPassword, emailChanged } = await syncLinkedUser(patient.UserId, patientFields, password));
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ success: false, message: err.message });
      }
      throw err;
    }

    const name = `${patientFields.firstName ?? patient.firstName} ${patientFields.lastName ?? patient.lastName}`;

    console.log(`[update] Case B — tempPassword=${!!tempPassword} emailChanged=${emailChanged}`);
    if (tempPassword) {
      // Existing User had no email — now activated for the first time
      console.log(`[update] Case B — sending welcome email to ${patientFields.email}`);
      sendPatientWelcomeEmail({ to: patientFields.email, name, uhid: patient.uhid, tempPassword }).catch(err => console.error('[update] Welcome email failed:', err.message));
    } else if (emailChanged && patientFields.email) {
      // Email address changed — notify the patient at the new address
      console.log(`[update] Case B — sending email-updated notification to ${patientFields.email}`);
      sendEmailUpdatedEmail({ to: patientFields.email, name, uhid: patient.uhid }).catch(err => console.error('[update] Email-updated notification failed:', err.message));
    }
  }

  const [full, latestVital, nextAppt, lastQueue] = await fetchFullPatient(patient.id);
  return success(res, {
    ...formatPatient(full, latestVital, nextAppt, lastQueue),
    ...(tempPassword ? { tempPassword } : {}),
  });
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
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [total, active, inactive, highRisk, mediumRisk, lowRisk, type1, type2, registeredToday] =
    await Promise.all([
      Patient.count(),
      Patient.count({ where: { status:      'Active'   } }),
      Patient.count({ where: { status:      'Inactive' } }),
      Patient.count({ where: { riskLevel:   'High'     } }),
      Patient.count({ where: { riskLevel:   'Medium'   } }),
      Patient.count({ where: { riskLevel:   'Low'      } }),
      Patient.count({ where: { diagnosis: 'Type 1'  } }),
      Patient.count({ where: { diagnosis: 'Type 2'  } }),
      Patient.count({ where: { createdAt: { [Op.gte]: startOfToday } } }),
    ]);

  return success(res, { total, active, inactive, highRisk, mediumRisk, lowRisk, type1, type2, registeredToday });
};

// ------------------------------------
// POST /api/patients/:uhid/vitals — record triage vitals
// ------------------------------------
const recordVitals = async (req, res) => {
  if (req.isDeactivated) {
    return res.status(403).json({ success: false, message: 'This patient profile is inactive. No new records can be added.' });
  }

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
// POST /api/patients/:uhid/vitals/doctor — doctor records/completes vitals
// All fields optional — doctor fills in what was missed at triage
// ------------------------------------
const recordVitalsDoctor = async (req, res) => {
  if (req.isDeactivated) {
    return res.status(403).json({ success: false, message: 'This patient profile is inactive. No new records can be added.' });
  }

  const { weight, height, waistCircumference } = req.body;

  const bmi = (weight && height)
    ? parseFloat((weight / Math.pow(height / 100, 2)).toFixed(1))
    : null;

  const waistHeightRatio = (waistCircumference && height)
    ? parseFloat((waistCircumference / height).toFixed(2))
    : null;

  const vital = await PatientVital.create({
    ...req.body,
    PatientId: req.patient.id,
    bmi:              bmi              ?? req.body.bmi              ?? null,
    waistHeightRatio: waistHeightRatio ?? req.body.waistHeightRatio ?? null,
  });

  return success(res, formatVitals(vital), 201);
};

// ------------------------------------
// GET /api/patients/:uhid/vitals — latest vitals
// ------------------------------------
const getVitals = async (req, res) => {
  const latestVital = await PatientVital.findOne({
    where: { PatientId: { [Op.in]: req.patientIds } },
    order: [['recordedAt', 'DESC']],
  });

  return success(res, formatVitals(latestVital));
};

// ------------------------------------
// GET /api/patients/:uhid/vitals/history — all vitals records newest first
// ------------------------------------
const getVitalsHistory = async (req, res) => {
  const vitals = await PatientVital.findAll({
    where: { PatientId: { [Op.in]: req.patientIds } },
    order: [['recordedAt', 'DESC']],
  });

  return success(res, vitals.map(formatVitals));
};

const updateSummary = async (req, res) => {
  try {
    if (req.isDeactivated) {
      return res.status(403).json({ success: false, message: 'This patient profile is inactive. No changes are allowed.' });
    }
    const { summary } = req.body;
    if (summary !== undefined && typeof summary !== 'string') {
      return error(res, 'Summary must be a string.', 400);
    }
    const patient = req.patient;
    const trimmed  = summary?.trim() || null;
    const doctorName = `Dr. ${req.user.name}`;
    await patient.update({
      patientSummary:   trimmed,
      summaryUpdatedBy: trimmed ? doctorName : null,
      summaryUpdatedAt: trimmed ? new Date() : null,
    });
    return success(res, {
      patientSummary:   patient.patientSummary,
      summaryUpdatedBy: patient.summaryUpdatedBy,
      summaryUpdatedAt: patient.summaryUpdatedAt,
    });
  } catch (err) {
    console.error('Update patient summary error:', err.message);
    return error(res, 'Failed to update patient summary.', 500);
  }
};

// ------------------------------------
// GET /api/patients/duplicates — admin: list all active patient pairs sharing the same idNumber
// ------------------------------------
const getDuplicates = async (req, res) => {
  const groups = await Patient.findAll({
    attributes: ['idNumber', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'cnt']],
    where: {
      idNumber:    { [Op.not]: null, [Op.ne]: '' },
      status:      { [Op.ne]: 'Inactive' },
      mergedIntoId: null,
    },
    group: ['idNumber'],
    having: db.sequelize.literal('COUNT(id) > 1'),
    raw: true,
  });

  if (!groups.length) return success(res, []);

  const idNumbers = groups.map(g => g.idNumber);

  const patients = await Patient.findAll({
    where: { idNumber: { [Op.in]: idNumbers }, status: { [Op.ne]: 'Inactive' }, mergedIntoId: null },
    attributes: ['id', 'uhid', 'firstName', 'lastName', 'dateOfBirth', 'phone', 'gender', 'idNumber', 'createdAt', 'registeredBy', 'status', 'UserId'],
    order: [['idNumber', 'ASC'], ['createdAt', 'ASC']],
  });

  const map = {};
  patients.forEach(p => {
    const v = p.dataValues;
    if (!map[v.idNumber]) map[v.idNumber] = [];
    map[v.idNumber].push({
      id:              v.id,
      uhid:            v.uhid,
      firstName:       v.firstName,
      lastName:        v.lastName,
      name:            `${v.firstName} ${v.lastName}`.trim(),
      dateOfBirth:     v.dateOfBirth,
      phone:           v.phone,
      gender:          v.gender,
      idNumber:        v.idNumber,
      registeredAt:    v.createdAt,
      registeredBy:    v.registeredBy || 'Unknown',
      status:          v.status,
      hasPortalAccount: !!v.UserId,
    });
  });

  return success(res, Object.values(map).filter(g => g.length > 1));
};

// ------------------------------------
// POST /api/patients/merge — admin: merge duplicate into kept patient then deactivate it
// Body: { keepUhid, discardUhid }
// ------------------------------------
const mergePatients = async (req, res) => {
  const { keepUhid, discardUhid } = req.body;

  if (!keepUhid || !discardUhid) {
    return res.status(400).json({ success: false, message: 'keepUhid and discardUhid are required.' });
  }
  if (keepUhid === discardUhid) {
    return res.status(400).json({ success: false, message: 'keepUhid and discardUhid must be different patients.' });
  }

  const [keepPatient, discardPatient] = await Promise.all([
    Patient.findOne({ where: { uhid: keepUhid } }),
    Patient.findOne({ where: { uhid: discardUhid } }),
  ]);

  if (!keepPatient)    return res.status(404).json({ success: false, message: `Patient "${keepUhid}" not found.` });
  if (!discardPatient) return res.status(404).json({ success: false, message: `Patient "${discardUhid}" not found.` });
  if (discardPatient.mergedIntoId !== null) {
    return res.status(400).json({ success: false, message: `Patient "${discardUhid}" is already merged into another record.` });
  }
  if (keepPatient.status === 'Inactive') {
    return res.status(400).json({ success: false, message: `Patient "${keepUhid}" is inactive and cannot be the merge target.` });
  }

  const transaction = await sequelize.transaction();
  try {
    // Handle User portal accounts
    if (discardPatient.UserId) {
      if (!keepPatient.UserId) {
        // Transfer the portal account to the patient we are keeping
        await keepPatient.update({ UserId: discardPatient.UserId }, { transaction });
        await discardPatient.update({ UserId: null }, { transaction });
      } else {
        // Both have portal accounts — deactivate the discarded one
        await User.update({ isActive: false }, { where: { id: discardPatient.UserId }, transaction });
      }
    }

    // Link the discarded patient to the canonical one; clear idNumber to stop duplicate detection
    await discardPatient.update(
      { mergedIntoId: keepPatient.id, status: 'Inactive', idNumber: null },
      { transaction },
    );

    await transaction.commit();

    return success(res, {
      message:     `Patient ${discardUhid} merged into ${keepUhid} and deactivated.`,
      kept:        keepUhid,
      deactivated: discardUhid,
    });
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

// ------------------------------------
// PATCH /api/patients/:uhid/reactivate — admin: undo a merge and restore an inactive patient
// ------------------------------------
const reactivatePatient = async (req, res) => {
  const { uhid } = req.params;
  const patient = await Patient.findOne({ where: { uhid } });

  if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });
  if (patient.mergedIntoId === null) {
    return res.status(400).json({ success: false, message: 'This patient is not linked to a merge. Nothing to reactivate.' });
  }

  await patient.update({ mergedIntoId: null, status: 'Active' });

  return success(res, {
    message: `Patient ${uhid} has been reactivated successfully.`,
    uhid,
  });
};

// ------------------------------------
// GET /api/patients/check-id?idNumber=xxx
// Real-time duplicate check used by the registration form as staff types.
// Returns { exists: false } or { exists: true, uhid, name }.
// ------------------------------------
const checkIdNumber = async (req, res) => {
  const idNumber = (req.query.idNumber || '').trim();
  if (!idNumber) return success(res, { exists: false });

  const patient = await Patient.findOne({
    where: { idNumber },
    attributes: ['uhid', 'firstName', 'lastName'],
  });

  if (!patient) return success(res, { exists: false });

  return success(res, {
    exists: true,
    uhid: patient.uhid,
    name: `${patient.firstName} ${patient.lastName}`.trim(),
  });
};

module.exports = { create, quickCreate, completeRegistration, list, getOne, update, destroy, stats, recordVitals, recordVitalsDoctor, getVitals, getVitalsHistory, updateSummary, checkIdNumber, getDuplicates, mergePatients, reactivatePatient };
