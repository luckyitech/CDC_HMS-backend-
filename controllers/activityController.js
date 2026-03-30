const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');

const { Queue, Patient, MedicalDocument, MedicalEquipment, EquipmentHistory, User, Prescription, LabTest, TreatmentPlan, ConsultationNote, PhysicalExamination, InitialAssessment } = db;

// ── Shared event shape ────────────────────────────────────────────────────────

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
  document_uploaded:     'documentUploaded',
  equipment_added:       'equipmentAdded',
  equipment_updated:     'equipmentUpdated',
  equipment_replaced:    'equipmentReplaced',
  prescription_created:    'prescriptionCreated',
  lab_test_ordered:        'labTestOrdered',
  treatment_plan_created:  'treatmentPlanCreated',
  consultation_note:       'consultationNote',
  consultation_started:    'consultationStarted',
  consultation_completed:  'consultationCompleted',
  physical_exam:           'physicalExam',
  initial_assessment:      'initialAssessment',
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

    if (q.addedBy)            events.push(makeEvent('added_to_queue',       'Added to Queue',        q.addedBy,     patient, uhid, q.createdAt,                              null,                 'staff'));
    if (q.triagedBy)          events.push(makeEvent('triaged',               'Triaged Patient',       q.triagedBy,   patient, uhid, q.createdAt,                              null,                 'staff'));
    if (q.dischargedBy)       events.push(makeEvent('discharged',            'Discharged Patient',    q.dischargedBy,patient, uhid, q.consultationEndTime || q.updatedAt,      q.dischargeComment,   'staff'));
    if (q.removedBy)          events.push(makeEvent('removed',               'Removed from Queue',    q.removedBy,   patient, uhid, q.updatedAt,                              q.removalReason,      'staff'));
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
    const staff = d.uploader ? `${d.uploader.firstName} ${d.uploader.lastName}` : 'Unknown';
    const role  = d.uploadedByRole ? d.uploadedByRole.toLowerCase() : 'staff';
    return makeEvent('document_uploaded', 'Uploaded Document', staff, `${d.Patient.firstName} ${d.Patient.lastName}`, d.Patient.uhid, d.createdAt, d.documentCategory, role);
  });
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

  const [prescriptions, labTests, treatmentPlans, consultationNotes, physicalExams, assessments] = await Promise.all([
    Prescription.findAll({       where: dateWhere, include: [patientInclude, doctorInclude] }),
    LabTest.findAll({            where: dateWhere, include: [patientInclude, { model: User, as: 'orderedBy', attributes: doctorAttr }] }),
    TreatmentPlan.findAll({      where: dateWhere, include: [patientInclude, doctorInclude] }),
    ConsultationNote.findAll({   where: dateWhere, include: [patientInclude, doctorInclude] }),
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
    getEquipmentEvents(dateFilter, hasDateFilter),
    getDoctorEvents(dateFilter, hasDateFilter),
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
