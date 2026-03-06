const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const db = require('../models');

const { Queue, Patient, User } = db;

// ------------------------------------
// Helpers
// ------------------------------------

// Format a Date into "H:MM AM/PM"
const formatTime = (date) => {
  const d   = new Date(date);
  let hours = d.getHours();
  const min = d.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${String(min).padStart(2, '0')} ${ampm}`;
};

// Compute age from dateOfBirth
const computeAge = (dateOfBirth) => {
  if (!dateOfBirth) return null;
  const today = new Date();
  const dob = new Date(dateOfBirth);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
};

// Includes shared by every query that needs patient info + doctor name
const queueIncludes = [
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName', 'age', 'dateOfBirth', 'gender'] },
  { model: User,    as: 'assignedDoctor', attributes: ['firstName', 'lastName'] },
];

// Shape one queue row into the API response.
// position = 1-based index among Waiting items (null for non-Waiting).
const formatItem = (item, position) => {
  const q = item.dataValues || item;
  return {
    id:                    q.id,
    uhid:                  q.Patient.uhid,
    name:                  `${q.Patient.firstName} ${q.Patient.lastName}`,
    age:                   computeAge(q.Patient.dateOfBirth) ?? q.Patient.age,
    gender:                q.Patient.gender,
    arrivalTime:           formatTime(q.createdAt),
    createdAt:             q.createdAt,             // raw ISO — used for date filtering on frontend
    priority:              q.priority,
    status:                q.status,
    reason:                q.reason,
    estimatedWait:         position !== null ? `${position * 15} min` : null,
    assignedDoctorId:      q.assignedDoctorId,
    assignedDoctorName:    q.assignedDoctor
                             ? `Dr. ${q.assignedDoctor.firstName} ${q.assignedDoctor.lastName}`
                             : null,
    consultationStartTime: q.consultationStartTime || null,
    consultationEndTime:   q.consultationEndTime   || null,
    selectedCharges:       q.selectedCharges       || [],
    selectedProcedures:    q.selectedProcedures    || [],
  };
};

// ------------------------------------
// POST /api/queue — add patient to queue
// ------------------------------------
const add = async (req, res) => {
  const { uhid, priority = 'Normal', reason } = req.body;

  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) return error(res, 'Patient not found', 404);

  // Reject if patient is already in the queue and not yet Completed
  const existing = await Queue.findOne({
    where: {
      PatientId: patient.id,
      status:    { [Op.ne]: 'Completed' },
    },
  });
  if (existing) return error(res, 'Patient is already in the queue', 400);

  const item = await Queue.create({ PatientId: patient.id, priority, reason });

  // Re-fetch with joins for the response
  const full = await Queue.findByPk(item.id, { include: queueIncludes });

  // Compute position among all current Waiting items (Urgent first, then arrival order)
  const waitingItems = await Queue.findAll({
    where:  { status: 'Waiting' },
    order:  [['priority', 'DESC'], ['createdAt', 'ASC']],
    attributes: ['id'],
  });
  const position = waitingItems.findIndex(w => w.id === item.id) + 1;

  broadcast('queue_updated');
  return success(res, formatItem(full, position), 201);
};

// ------------------------------------
// GET /api/queue — list queue items
// Returns: all non-Completed records (any date) + today's Completed records.
// This ensures:
//   - Active patients are always visible until discharged, even across midnight
//   - Completed (discharged) patients only show for today's session reference
//   - Old discharged records never block re-adding a returning patient
// ------------------------------------
const list = async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const items = await Queue.findAll({
    where: {
      [Op.or]: [
        { status: { [Op.ne]: 'Completed' } },              // all active — any date
        { status: 'Completed', createdAt: { [Op.gte]: startOfToday } }, // today's discharged
      ],
    },
    include: queueIncludes,
    order:   [['priority', 'DESC'], ['createdAt', 'ASC']], // Urgent first, then arrival
  });

  // Assign sequential positions only to Waiting items (already in correct order)
  let waitingPos = 0;
  const formatted = items.map(item => {
    if (item.status === 'Waiting') {
      waitingPos++;
      return formatItem(item, waitingPos);
    }
    return formatItem(item, null);
  });

  return success(res, formatted);
};

// ------------------------------------
// PUT /api/queue/:id — update status or assign doctor
// ------------------------------------
const update = async (req, res) => {
  const item = await Queue.findByPk(req.params.id);
  if (!item) return error(res, 'Queue item not found', 404);

  // Strip response-only computed fields — not DB columns
  const { assignedDoctorName, ...updates } = req.body;

  // Auto-set timestamps on status transitions
  if (updates.status === 'With Doctor')     updates.consultationStartTime = new Date();
  if (updates.status === 'Pending Billing') updates.consultationEndTime   = new Date();
  if (updates.status === 'Completed')       updates.consultationEndTime   = updates.consultationEndTime || new Date();

  await item.update(updates);

  // Re-fetch with joins
  const updated = await Queue.findByPk(item.id, { include: queueIncludes });
  broadcast('queue_updated');
  return success(res, formatItem(updated, null));
};

// ------------------------------------
// DELETE /api/queue/:id — remove from queue
// ------------------------------------
const remove = async (req, res) => {
  const item = await Queue.findByPk(req.params.id);
  if (!item) return error(res, 'Queue item not found', 404);

  await item.destroy();
  broadcast('queue_updated');
  return success(res, { message: 'Removed from queue' });
};

// ------------------------------------
// GET /api/queue/stats — queue statistics
// ------------------------------------
const stats = async (req, res) => {
  const [total, waiting, inTriage, withDoctor, pendingBilling, completed, urgent] =
    await Promise.all([
      Queue.count(),
      Queue.count({ where: { status: 'Waiting' } }),
      Queue.count({ where: { status: 'In Triage' } }),
      Queue.count({ where: { status: 'With Doctor' } }),
      Queue.count({ where: { status: 'Pending Billing' } }),
      Queue.count({ where: { status: 'Completed' } }),
      Queue.count({ where: { priority: 'Urgent' } }),
    ]);

  return success(res, { total, waiting, inTriage, withDoctor, pendingBilling, completed, urgent });
};

// ------------------------------------
// POST /api/queue/call-next — doctor pulls the next waiting patient
// ------------------------------------
const callNext = async (req, res) => {
  // First Waiting item: Urgent patients before Normal, oldest first within each
  const next = await Queue.findOne({
    where:   { status: 'Waiting' },
    order:   [['priority', 'DESC'], ['createdAt', 'ASC']],
    include: queueIncludes,
  });

  if (!next) return error(res, 'No patients waiting', 404);

  await next.update({ status: 'With Doctor', consultationStartTime: new Date() });

  // Re-fetch after update
  const updated = await Queue.findByPk(next.id, { include: queueIncludes });
  broadcast('queue_updated');
  return success(res, formatItem(updated, null));
};

module.exports = { add, list, update, remove, stats, callNext };
