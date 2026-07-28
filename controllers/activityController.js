const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');

const { Queue, Patient, MedicalDocument, MedicalEquipment, EquipmentHistory, User, Prescription, LabTest, TreatmentPlan, ConsultationNote, PhysicalExamination, InitialAssessment, UserLoginLog, Appointment, DoctorBlock, BarcodeScan } = db;

// ── Shared event shape ────────────────────────────────────────────────────────

// NOTE: `detail` is a single display string — if an event has multiple pieces of context
// (e.g. type + reason + target), concatenate them before passing: `${a} · ${b} · ${c}`.
// Do NOT add new fields to this shape; keep the contract stable so the frontend never changes.
const makeEvent = (type, label, staff, patient, uhid, timestamp, detail = null, role = null) => ({
  type, label, staff, patient, uhid, timestamp, detail, role,
});

// ── Summary builder ───────────────────────────────────────────────────────────

const SUMMARY_KEYS = {
  registered:            'registered',
  added_to_queue:        'addedToQueue',
  triaged:               'triaged',
  discharged:            'discharged',
  removed:               'removed',
  referred:              'referred',
  document_uploaded:     'documentUploaded',
  document_reviewed:     'documentReviewed',
  equipment_added:       'equipmentAdded',
  equipment_updated:     'equipmentUpdated',
  equipment_replaced:    'equipmentReplaced',
  prescription_created:    'prescriptionCreated',
  lab_test_ordered:        'labTestOrdered',
  treatment_plan_created:  'treatmentPlanCreated',
  consultation_note:         'consultationNote',
  consultation_note_edited:  'consultationNoteEdited',
  consultation_started:      'consultationStarted',
  consultation_completed:  'consultationCompleted',
  physical_exam:           'physicalExam',
  initial_assessment:      'initialAssessment',
  account_created:         'accountCreated',
  user_login:              'userLogin',
  appointment_booked:      'appointmentBooked',
  appointment_cancelled:   'appointmentCancelled',
  slot_blocked:            'slotBlocked',
  barcode_scanned:         'barcodeScanned',
  barcode_generated:       'barcodeGenerated',
};

const buildSummary = (events) => {
  const map = {};
  for (const e of events) {
    if (!map[e.staff]) {
      map[e.staff] = { staff: e.staff, role: e.role, total: 0, ...Object.fromEntries(Object.values(SUMMARY_KEYS).map(k => [k, 0])) };
    }
    map[e.staff].total++;
    const key = SUMMARY_KEYS[e.type];
    if (key) map[e.staff][key]++;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
};

// ── Event sources (each returns Event[]) ─────────────────────────────────────

const getRegistrationEvents = async (dateFilter, hasDateFilter) => {
  const patients = await Patient.findAll({
    where: hasDateFilter ? { createdAt: dateFilter } : {},
    attributes: ['uhid', 'firstName', 'lastName', 'registeredBy', 'registeredByRole', 'createdAt'],
  });

  return patients.map(p =>
    makeEvent('registered', 'Registered Patient', p.registeredBy || 'Unknown', `${p.firstName} ${p.lastName}`, p.uhid, p.createdAt, null, p.registeredByRole || 'staff')
  );
};

const getQueueEvents = async (dateFilter, hasDateFilter) => {
  const items = await Queue.findAll({
    where: {
      [Op.or]: [
        { addedBy:              { [Op.ne]: null } },
        { triagedBy:            { [Op.ne]: null } },
        { dischargedBy:         { [Op.ne]: null } },
        { removedBy:            { [Op.ne]: null } },
        { consultationStartTime:{ [Op.ne]: null } },
        { consultationEndTime:  { [Op.ne]: null } },
      ],
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'assignedDoctor', attributes: ['firstName', 'lastName'] },
    ],
  });

  const events = [];
  for (const q of items) {
    const patient = `${q.Patient.firstName} ${q.Patient.lastName}`;
    const { uhid } = q.Patient;
    const doctor   = q.assignedDoctor ? `Dr. ${q.assignedDoctor.firstName} ${q.assignedDoctor.lastName}` : null;

    if (q.addedBy)            events.push(makeEvent('added_to_queue',       'Added to Queue',        q.addedBy,              patient, uhid, q.createdAt,                          null,               'staff'));
    if (q.triagedBy)          events.push(makeEvent('triaged',               'Triaged Patient',       q.triagedBy,            patient, uhid, q.createdAt,                          null,               'staff'));
    if (q.dischargedBy)       events.push(makeEvent('discharged',            'Discharged Patient',    q.dischargedBy,         patient, uhid, q.consultationEndTime || q.updatedAt, q.dischargeComment, 'staff'));
    if (q.removedBy)          events.push(makeEvent('removed',               'Removed from Queue',    q.removedBy,            patient, uhid, q.updatedAt,                          q.removalReason,    'staff'));
    if (q.referredByDoctorName && q.referredAt) {
      const referralDetail = q.referralType === 'Internal'
        ? `Internal → ${q.referredToDoctorName || 'Another Doctor'}${q.referralReason ? ` · ${q.referralReason}` : ''}`
        : `External → ${q.externalReferralTarget || 'External Facility'}${q.referralReason ? ` · ${q.referralReason}` : ''}`;
      events.push(makeEvent('referred', 'Referred Patient', q.referredByDoctorName, patient, uhid, q.referredAt, referralDetail, 'doctor'));
    }
    if (q.consultationStartTime && doctor) events.push(makeEvent('consultation_started',   'Started Consultation',   doctor, patient, uhid, q.consultationStartTime, null, 'doctor'));
    if (q.consultationEndTime   && doctor) events.push(makeEvent('consultation_completed', 'Completed Consultation', doctor, patient, uhid, q.consultationEndTime,   null, 'doctor'));
  }
  return events;
};

const getDocumentEvents = async (dateFilter, hasDateFilter) => {
  const docs = await MedicalDocument.findAll({
    where: {
      uploadedByRole: { [Op.in]: ['Doctor', 'Staff'] }, // exclude patient self-uploads
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'uploader', attributes: ['firstName', 'lastName'] },
    ],
  });

  return docs.map(d => {
    const role  = d.uploadedByRole ? d.uploadedByRole.toLowerCase() : 'staff';
    const staff = d.uploader
      ? (role === 'doctor' ? `Dr. ${d.uploader.firstName} ${d.uploader.lastName}` : `${d.uploader.firstName} ${d.uploader.lastName}`)
      : 'Unknown';
    return makeEvent('document_uploaded', 'Uploaded Document', staff, `${d.Patient.firstName} ${d.Patient.lastName}`, d.Patient.uhid, d.createdAt, d.documentCategory, role);
  });
};

const getDocumentReviewedEvents = async (dateFilter, hasDateFilter) => {
  const docs = await MedicalDocument.findAll({
    where: {
      status:           'Reviewed',
      reviewedBy:       { [Op.ne]: null },
      reviewDate:       { [Op.ne]: null },
      uploadedByRole:   { [Op.in]: ['Staff', 'Lab'] }, // only staff/lab uploads reviewed by a doctor
      ...(hasDateFilter ? { reviewDate: dateFilter } : {}),
    },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
    ],
  });

  return docs.map(d =>
    makeEvent(
      'document_reviewed',
      'Reviewed Document',
      d.reviewedBy,
      `${d.Patient.firstName} ${d.Patient.lastName}`,
      d.Patient.uhid,
      d.reviewDate,
      d.documentCategory,
      'doctor'
    )
  );
};

const getEquipmentEvents = async (dateFilter, hasDateFilter) => {
  const [added, updated, replaced] = await Promise.all([
    MedicalEquipment.findAll({
      where: {
        addedBy: { [Op.ne]: null },
        ...(hasDateFilter ? { addedDate: dateFilter } : {}),
      },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'addedByUser', attributes: ['firstName', 'lastName', 'role'] },
      ],
    }),
    MedicalEquipment.findAll({
      where: {
        lastUpdatedBy: { [Op.ne]: null },
        ...(hasDateFilter ? { lastUpdatedDate: dateFilter } : {}),
      },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'updatedByUser', attributes: ['firstName', 'lastName', 'role'] },
      ],
    }),
    EquipmentHistory.findAll({
      where: {
        archivedBy: { [Op.ne]: null },
        ...(hasDateFilter ? { archivedDate: dateFilter } : {}),
      },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'archivedByUser', attributes: ['firstName', 'lastName', 'role'] },
      ],
    }),
  ]);

  const events = [];
  for (const e of added) {
    const staff = e.addedByUser ? `${e.addedByUser.firstName} ${e.addedByUser.lastName}` : 'Unknown';
    const role  = e.addedByUser?.role?.toLowerCase() || 'staff';
    events.push(makeEvent('equipment_added', 'Added Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.addedDate, `${e.deviceType} · Serial: ${e.serialNo}`, role));
  }
  for (const e of updated) {
    const staff = e.updatedByUser ? `${e.updatedByUser.firstName} ${e.updatedByUser.lastName}` : 'Unknown';
    const role  = e.updatedByUser?.role?.toLowerCase() || 'staff';
    events.push(makeEvent('equipment_updated', 'Updated Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.lastUpdatedDate, `${e.deviceType} · Serial: ${e.serialNo}`, role));
  }
  for (const e of replaced) {
    const staff = e.archivedByUser ? `${e.archivedByUser.firstName} ${e.archivedByUser.lastName}` : 'Unknown';
    const role  = e.archivedByUser?.role?.toLowerCase() || 'staff';
    events.push(makeEvent('equipment_replaced', 'Replaced Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.archivedDate, e.reason, role));
  }
  return events;
};

const getDoctorEvents = async (dateFilter, hasDateFilter) => {
  const dateWhere = hasDateFilter ? { createdAt: dateFilter } : {};
  const doctorAttr = ['firstName', 'lastName'];

  const patientInclude = { model: Patient, attributes: ['uhid', 'firstName', 'lastName'], required: true };

  const doctorInclude = { model: User, as: 'doctor', attributes: doctorAttr };

  const editedNoteWhere = {
    updatedAt: hasDateFilter ? dateFilter : { [Op.ne]: null },
    [Op.and]: db.sequelize.literal('`ConsultationNote`.`updatedAt` > `ConsultationNote`.`createdAt`'),
  };

  const [prescriptions, labTests, treatmentPlans, consultationNotes, editedNotes, physicalExams, assessments] = await Promise.all([
    Prescription.findAll({       where: dateWhere, include: [patientInclude, doctorInclude] }),
    LabTest.findAll({            where: dateWhere, include: [patientInclude, { model: User, as: 'orderedBy', attributes: doctorAttr }] }),
    TreatmentPlan.findAll({      where: dateWhere, include: [patientInclude, doctorInclude] }),
    ConsultationNote.findAll({   where: dateWhere, include: [patientInclude, doctorInclude] }),
    ConsultationNote.findAll({   where: editedNoteWhere, include: [patientInclude, doctorInclude], attributes: ['id', 'updatedAt', 'doctorId'] }),
    PhysicalExamination.findAll({where: dateWhere, include: [patientInclude, doctorInclude] }),
    InitialAssessment.findAll({  where: dateWhere, include: [patientInclude, doctorInclude] }),
  ]);

  const events = [];

  for (const r of prescriptions) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('prescription_created', 'Wrote Prescription', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, null, 'doctor'));
  }
  for (const r of labTests) {
    const doctor = r.orderedBy ? `Dr. ${r.orderedBy.firstName} ${r.orderedBy.lastName}` : 'Unknown';
    events.push(makeEvent('lab_test_ordered', 'Ordered Lab Test', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, r.testType, 'doctor'));
  }
  for (const r of treatmentPlans) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('treatment_plan_created', 'Created Treatment Plan', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, null, 'doctor'));
  }
  for (const r of consultationNotes) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('consultation_note', 'Wrote Consultation Note', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, null, 'doctor'));
  }
  for (const r of editedNotes) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('consultation_note_edited', 'Edited Consultation Note', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.updatedAt, null, 'doctor'));
  }
  for (const r of physicalExams) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('physical_exam', 'Recorded Physical Exam', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, null, 'doctor'));
  }
  for (const r of assessments) {
    const doctor = r.doctor ? `Dr. ${r.doctor.firstName} ${r.doctor.lastName}` : 'Unknown';
    events.push(makeEvent('initial_assessment', 'Recorded Initial Assessment', doctor, `${r.Patient.firstName} ${r.Patient.lastName}`, r.Patient.uhid, r.createdAt, null, 'doctor'));
  }

  return events;
};

const ACCOUNT_ROLE_LABEL = { doctor: 'Doctor', staff: 'Staff', lab: 'Lab Tech' };

const getAccountCreationEvents = async (dateFilter, hasDateFilter) => {
  const users = await User.findAll({
    where: {
      role: { [Op.in]: ['doctor', 'staff', 'lab'] },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    attributes: ['firstName', 'lastName', 'role', 'createdBy', 'createdAt'],
  });

  return users.map(u =>
    makeEvent(
      'account_created',
      'Created Account',
      u.createdBy || 'Unknown',
      `${u.firstName} ${u.lastName}`,
      null,
      u.createdAt,
      `${ACCOUNT_ROLE_LABEL[u.role] || u.role} account`,
      'admin'
    )
  );
};

const getLoginEvents = async (dateFilter, hasDateFilter) => {
  const logs = await UserLoginLog.findAll({
    where: hasDateFilter ? { loginAt: dateFilter } : {},
    attributes: ['userId', 'name', 'role', 'ipAddress', 'loginAt'],
    order: [['loginAt', 'DESC']],
  });

  return logs.map(l =>
    makeEvent('user_login', 'Logged In', l.name, null, null, l.loginAt, l.ipAddress || null, l.role)
  );
};

const getAppointmentEvents = async (dateFilter, hasDateFilter) => {
  const appointments = await Appointment.findAll({
    where: {
      bookedByRole: { [Op.in]: ['staff', 'doctor'] },
      bookedBy:     { [Op.ne]: null },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
    ],
  });

  return appointments.map(a => {
    const doctorName = a.doctor ? `Dr. ${a.doctor.firstName} ${a.doctor.lastName}` : 'Unknown Doctor';
    const detail     = `${a.appointmentType || 'appointment'} · ${a.timeSlot} · ${doctorName}`;
    const role       = a.bookedByRole || 'staff';
    return makeEvent(
      'appointment_booked', 'Booked Appointment',
      a.bookedBy,
      `${a.Patient.firstName} ${a.Patient.lastName}`,
      a.Patient.uhid,
      a.bookedAt || a.createdAt,
      detail,
      role
    );
  });
};

const getAppointmentCancellationEvents = async (dateFilter, hasDateFilter) => {
  const appointments = await Appointment.findAll({
    where: {
      status:          'cancelled',
      cancelledBy:     { [Op.ne]: null },
      ...(hasDateFilter ? { cancelledAt: dateFilter } : {}),
    },
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
    ],
  });

  return appointments.map(a => {
    const doctorName = a.doctor ? `Dr. ${a.doctor.firstName} ${a.doctor.lastName}` : 'Unknown Doctor';
    const detail     = `${a.appointmentType || 'appointment'} · ${a.timeSlot} · ${doctorName}`;
    const role       = a.cancelledByRole || 'staff';
    return makeEvent(
      'appointment_cancelled', 'Cancelled Appointment',
      a.cancelledBy,
      `${a.Patient.firstName} ${a.Patient.lastName}`,
      a.Patient.uhid,
      a.cancelledAt,
      detail,
      role
    );
  });
};

const getDoctorBlockEvents = async (dateFilter, hasDateFilter) => {
  const blocks = await DoctorBlock.findAll({
    where: {
      blockedBy: { [Op.ne]: null },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    include: [
      { model: User, as: 'doctor', attributes: ['firstName', 'lastName'] },
    ],
    attributes: ['blockedBy', 'date', 'timeSlot', 'reason', 'createdAt'],
  });

  return blocks.map(b => {
    const slotLabel = b.timeSlot === 'ALL_DAY' ? 'Full Day' : b.timeSlot;
    const detail    = `${slotLabel} · ${b.date}${b.reason ? ` · ${b.reason}` : ''}`;
    return makeEvent('slot_blocked', 'Blocked Slot', b.blockedBy, null, null, b.createdAt, detail, 'doctor');
  });
};

const BARCODE_ACTION_META = {
  scan:        { type: 'barcode_scanned',   label: 'Scanned Barcode' },
  print_card:  { type: 'barcode_generated', label: 'Generated Barcode' },
  print_label: { type: 'barcode_generated', label: 'Generated Barcode' },
  email:       { type: 'barcode_generated', label: 'Generated Barcode' },
};

const BARCODE_DETAIL = {
  print_card:  'ID card printed',
  print_label: 'File label printed',
  email:       'Card emailed to patient',
};

const getBarcodeEvents = async (dateFilter, hasDateFilter) => {
  const rows = await BarcodeScan.findAll({
    where: hasDateFilter ? { createdAt: dateFilter } : {},
    include: [
      { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
      { model: User, as: 'scannedByUser', attributes: ['firstName', 'lastName', 'role'] },
    ],
  });

  return rows.map(r => {
    const meta = BARCODE_ACTION_META[r.action] || BARCODE_ACTION_META.scan;
    const role = r.scannedByUser?.role?.toLowerCase() || 'staff';
    const user = r.scannedByUser
      ? (role === 'doctor' ? `Dr. ${r.scannedByUser.firstName} ${r.scannedByUser.lastName}` : `${r.scannedByUser.firstName} ${r.scannedByUser.lastName}`)
      : 'Unknown';
    const detail = (r.action === 'scan' || !r.action)
      ? `${r.source === 'camera' ? 'Camera' : 'USB scanner'}${r.redirectedFromUhid ? ` · redirected from ${r.redirectedFromUhid}` : ''}`
      : BARCODE_DETAIL[r.action] || null;
    return makeEvent(
      meta.type, meta.label, user,
      r.Patient ? `${r.Patient.firstName} ${r.Patient.lastName}` : null,
      r.Patient ? r.Patient.uhid : r.rawPayload,
      r.createdAt, detail, role
    );
  });
};

// ── Controller ────────────────────────────────────────────────────────────────

const getActivityLog = async (req, res) => {
  const { startDate, endDate, staff, action } = req.query;

  const dateFilter = {};
  if (startDate) dateFilter[Op.gte] = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter[Op.lte] = end;
  }
  const hasDateFilter = !!(startDate || endDate);

  // Fetch all sources in parallel
  const allEvents = (await Promise.all([
    getRegistrationEvents(dateFilter, hasDateFilter),
    getQueueEvents(dateFilter, hasDateFilter),
    getDocumentEvents(dateFilter, hasDateFilter),
    getDocumentReviewedEvents(dateFilter, hasDateFilter),
    getEquipmentEvents(dateFilter, hasDateFilter),
    getDoctorEvents(dateFilter, hasDateFilter),
    getAccountCreationEvents(dateFilter, hasDateFilter),
    getLoginEvents(dateFilter, hasDateFilter),
    getAppointmentEvents(dateFilter, hasDateFilter),
    getAppointmentCancellationEvents(dateFilter, hasDateFilter),
    getDoctorBlockEvents(dateFilter, hasDateFilter),
    getBarcodeEvents(dateFilter, hasDateFilter),
  ])).flat();

  // Summary uses all events (unfiltered)
  const summary = buildSummary(allEvents);

  // Apply optional filters
  let filtered = allEvents;
  if (staff) {
    const lower = staff.toLowerCase();
    filtered = filtered.filter(e => e.staff.toLowerCase().includes(lower));
  }
  if (action && action !== 'all') {
    filtered = filtered.filter(e => e.type === action);
  }

  // Most recent first
  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return success(res, { events: filtered, summary });
};

module.exports = { getActivityLog };
