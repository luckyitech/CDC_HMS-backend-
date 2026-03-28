const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');

const { Queue, Patient, MedicalDocument, MedicalEquipment, EquipmentHistory, User } = db;

// ── Shared event shape ────────────────────────────────────────────────────────

const makeEvent = (type, label, staff, patient, uhid, timestamp, detail = null) => ({
  type, label, staff, patient, uhid, timestamp, detail,
});

// ── Summary builder ───────────────────────────────────────────────────────────

const SUMMARY_KEYS = {
  registered:         'registered',
  added_to_queue:     'addedToQueue',
  triaged:            'triaged',
  discharged:         'discharged',
  removed:            'removed',
  document_uploaded:  'documentUploaded',
  equipment_added:    'equipmentAdded',
  equipment_updated:  'equipmentUpdated',
  equipment_replaced: 'equipmentReplaced',
};

const buildSummary = (events) => {
  const map = {};
  for (const e of events) {
    if (!map[e.staff]) {
      map[e.staff] = { staff: e.staff, total: 0, ...Object.fromEntries(Object.values(SUMMARY_KEYS).map(k => [k, 0])) };
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
    where: {
      registeredBy: { [Op.ne]: null },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    attributes: ['uhid', 'firstName', 'lastName', 'registeredBy', 'createdAt'],
  });

  return patients.map(p =>
    makeEvent('registered', 'Registered Patient', p.registeredBy, `${p.firstName} ${p.lastName}`, p.uhid, p.createdAt)
  );
};

const getQueueEvents = async (dateFilter, hasDateFilter) => {
  const items = await Queue.findAll({
    where: {
      [Op.or]: [
        { addedBy:     { [Op.ne]: null } },
        { triagedBy:   { [Op.ne]: null } },
        { dischargedBy:{ [Op.ne]: null } },
        { removedBy:   { [Op.ne]: null } },
      ],
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }],
  });

  const events = [];
  for (const q of items) {
    const patient = `${q.Patient.firstName} ${q.Patient.lastName}`;
    const { uhid } = q.Patient;
    if (q.addedBy)     events.push(makeEvent('added_to_queue', 'Added to Queue',    q.addedBy,     patient, uhid, q.createdAt));
    if (q.triagedBy)   events.push(makeEvent('triaged',        'Triaged Patient',   q.triagedBy,   patient, uhid, q.createdAt));
    if (q.dischargedBy)events.push(makeEvent('discharged',     'Discharged Patient',q.dischargedBy,patient, uhid, q.consultationEndTime || q.updatedAt, q.dischargeComment));
    if (q.removedBy)   events.push(makeEvent('removed',        'Removed from Queue',q.removedBy,   patient, uhid, q.updatedAt, q.removalReason));
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
    return makeEvent('document_uploaded', 'Uploaded Document', staff, `${d.Patient.firstName} ${d.Patient.lastName}`, d.Patient.uhid, d.createdAt, d.documentCategory);
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
        { model: User, as: 'addedByUser', attributes: ['firstName', 'lastName'] },
      ],
    }),
    MedicalEquipment.findAll({
      where: {
        lastUpdatedBy: { [Op.ne]: null },
        ...(hasDateFilter ? { lastUpdatedDate: dateFilter } : {}),
      },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'updatedByUser', attributes: ['firstName', 'lastName'] },
      ],
    }),
    EquipmentHistory.findAll({
      where: {
        archivedBy: { [Op.ne]: null },
        ...(hasDateFilter ? { archivedDate: dateFilter } : {}),
      },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'archivedByUser', attributes: ['firstName', 'lastName'] },
      ],
    }),
  ]);

  const events = [];
  for (const e of added) {
    const staff = e.addedByUser ? `${e.addedByUser.firstName} ${e.addedByUser.lastName}` : 'Unknown';
    events.push(makeEvent('equipment_added', 'Added Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.addedDate, `${e.deviceType} · Serial: ${e.serialNo}`));
  }
  for (const e of updated) {
    const staff = e.updatedByUser ? `${e.updatedByUser.firstName} ${e.updatedByUser.lastName}` : 'Unknown';
    events.push(makeEvent('equipment_updated', 'Updated Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.lastUpdatedDate, `${e.deviceType} · Serial: ${e.serialNo}`));
  }
  for (const e of replaced) {
    const staff = e.archivedByUser ? `${e.archivedByUser.firstName} ${e.archivedByUser.lastName}` : 'Unknown';
    events.push(makeEvent('equipment_replaced', 'Replaced Equipment', staff, `${e.Patient.firstName} ${e.Patient.lastName}`, e.Patient.uhid, e.archivedDate, e.reason));
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
