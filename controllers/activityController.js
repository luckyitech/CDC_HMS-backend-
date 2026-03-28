const { Op } = require('sequelize');
const { success } = require('../utils/response');
const db = require('../models');

const { Queue, Patient } = db;

// ------------------------------------
// GET /api/activity — staff activity log (admin only)
// ------------------------------------
const getActivityLog = async (req, res) => {
  const { startDate, endDate, staff, action } = req.query;

  // Build optional date filter on createdAt
  const dateFilter = {};
  if (startDate) dateFilter[Op.gte] = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    dateFilter[Op.lte] = end;
  }
  const hasDateFilter = Object.keys(dateFilter).length > 0;

  // Fetch patients that have a registeredBy value
  const patients = await Patient.findAll({
    where: {
      registeredBy: { [Op.ne]: null },
      ...(hasDateFilter ? { createdAt: dateFilter } : {}),
    },
    attributes: ['uhid', 'firstName', 'lastName', 'registeredBy', 'createdAt'],
  });

  // Fetch queue items that have at least one accountability field set
  const queueItems = await Queue.findAll({
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

  // Build a flat events array
  const events = [];

  for (const p of patients) {
    events.push({
      type:      'registered',
      label:     'Registered Patient',
      staff:     p.registeredBy,
      patient:   `${p.firstName} ${p.lastName}`,
      uhid:      p.uhid,
      timestamp: p.createdAt,
      detail:    null,
    });
  }

  for (const q of queueItems) {
    const patient = `${q.Patient.firstName} ${q.Patient.lastName}`;
    const uhid = q.Patient.uhid;

    if (q.addedBy) {
      events.push({
        type:      'added_to_queue',
        label:     'Added to Queue',
        staff:     q.addedBy,
        patient,
        uhid,
        timestamp: q.createdAt,
        detail:    null,
      });
    }
    if (q.triagedBy) {
      events.push({
        type:      'triaged',
        label:     'Triaged Patient',
        staff:     q.triagedBy,
        patient,
        uhid,
        timestamp: q.createdAt, // closest available timestamp for triage
        detail:    null,
      });
    }
    if (q.dischargedBy) {
      events.push({
        type:      'discharged',
        label:     'Discharged Patient',
        staff:     q.dischargedBy,
        patient,
        uhid,
        timestamp: q.consultationEndTime || q.updatedAt,
        detail:    q.dischargeComment || null,
      });
    }
    if (q.removedBy) {
      events.push({
        type:      'removed',
        label:     'Removed from Queue',
        staff:     q.removedBy,
        patient,
        uhid,
        timestamp: q.updatedAt,
        detail:    q.removalReason || null,
      });
    }
  }

  // Build summary from ALL events (before filtering)
  const summaryMap = {};
  for (const e of events) {
    if (!summaryMap[e.staff]) {
      summaryMap[e.staff] = { staff: e.staff, registered: 0, addedToQueue: 0, triaged: 0, discharged: 0, removed: 0, total: 0 };
    }
    const s = summaryMap[e.staff];
    s.total++;
    if      (e.type === 'registered')    s.registered++;
    else if (e.type === 'added_to_queue') s.addedToQueue++;
    else if (e.type === 'triaged')       s.triaged++;
    else if (e.type === 'discharged')    s.discharged++;
    else if (e.type === 'removed')       s.removed++;
  }
  const summary = Object.values(summaryMap).sort((a, b) => b.total - a.total);

  // Apply filters on events
  let filtered = [...events];
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
