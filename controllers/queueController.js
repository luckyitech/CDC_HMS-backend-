const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const db = require('../models');

const { Queue, Patient, User } = db;

// ------------------------------------
// Consultation session helpers
// ------------------------------------

// Opens a new session for the given doctor on the queue item.
const pushSession = (item, doctorId, doctorName) => {
  const sessions = Array.isArray(item.consultationSessions) ? [...item.consultationSessions] : [];
  sessions.push({ doctorId, doctorName, startTime: new Date(), endTime: null });
  return sessions;
};

// Closes the most recent open session (endTime === null).
const closeLastSession = (item) => {
  if (!Array.isArray(item.consultationSessions)) return item.consultationSessions;
  const sessions = [...item.consultationSessions];
  const last = sessions.findLastIndex(s => !s.endTime);
  if (last !== -1) sessions[last] = { ...sessions[last], endTime: new Date() };
  return sessions;
};

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
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName', 'dateOfBirth', 'gender'] },
  { model: User,    as: 'assignedDoctor', attributes: ['firstName', 'lastName'] },
];

// Shape one queue row into the API response.
// position = 1-based index among Awaiting Triage items (null for all other statuses).
const formatItem = (item, position) => {
  const q = item.dataValues || item;
  return {
    id:                    q.id,
    uhid:                  q.Patient.uhid,
    name:                  `${q.Patient.firstName} ${q.Patient.lastName}`,
    age:                   computeAge(q.Patient.dateOfBirth),
    gender:                q.Patient.gender,
    arrivalTime:           formatTime(q.createdAt),
    createdAt:             q.createdAt,
    priority:              q.priority,
    status:                q.status,
    reason:                q.reason,
    estimatedWait:         position !== null ? `${position * 15} min` : null,
    assignedDoctorId:      q.assignedDoctorId,
    assignedDoctorName:    q.assignedDoctor
                             ? `Dr. ${q.assignedDoctor.firstName} ${q.assignedDoctor.lastName}`
                             : null,
    triageStartTime:        q.triageStartTime        || null,
    triageEndTime:          q.triageEndTime          || null,
    consultationStartTime:  q.consultationStartTime  || null,
    consultationEndTime:    q.consultationEndTime    || null,
    consultationSessions:   q.consultationSessions   || [],
    selectedCharges:       q.selectedCharges       || [],
    selectedProcedures:    q.selectedProcedures    || [],
    doctorNotes:           q.doctorNotes           || null,
    finalCharges:          q.finalCharges          || [],
    finalProcedures:       q.finalProcedures       || [],
    dischargeComment:      q.dischargeComment      || null,
    addedBy:               q.addedBy               || null,
    triagedBy:             q.triagedBy             || null,
    dischargedBy:          q.dischargedBy          || null,
    removedBy:             q.removedBy             || null,
    removalReason:         q.removalReason         || null,
    // Referral audit trail — null on non-referred entries
    referralType:           q.referralType          || null,
    referralReason:         q.referralReason        || null,
    referredByDoctorName:   q.referredByDoctorName  || null,
    referredAt:             q.referredAt            || null,
    referredToDoctorName:   q.referredToDoctorName  || null,
    externalReferralTarget: q.externalReferralTarget|| null,
  };
};

// ------------------------------------
// POST /api/queue — add patient to queue
// ------------------------------------
const add = async (req, res) => {
  try {
    const { uhid, priority = 'Normal', reason, isReview = false, assignedDoctorId = null } = req.body;

    const patient = await Patient.findOne({ where: { uhid } });
    if (!patient) return error(res, 'Patient not found', 404);

    // Reject if patient is already in the queue and not yet Completed or Removed
    const existing = await Queue.findOne({
      where: {
        PatientId: patient.id,
        status:    { [Op.notIn]: ['Completed', 'Removed'] },
      },
    });
    if (existing) return error(res, 'Patient is already in the queue', 400);

    // Review visits: verify patient was actually discharged today before skipping triage
    if (isReview) {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const dischargedToday = await Queue.findOne({
        where: { PatientId: patient.id, status: 'Completed', createdAt: { [Op.gte]: startOfToday } },
      });
      if (!dischargedToday) return error(res, 'Review visit is only allowed if the patient was discharged today', 400);
      if (!assignedDoctorId) return error(res, 'A doctor must be assigned for review visits', 400);
    }

    // Review visits skip triage — patient goes straight to Awaiting Doctor.
    // NOTE: if a new visit type is added (e.g. 'urgent-review'), update this condition
    // and the matching visitType check in PatientSearch.jsx → handleConfirmAddToQueue()
    const initialStatus = isReview ? 'Awaiting Doctor' : 'Awaiting Triage';

    const item = await Queue.create({
      PatientId:        patient.id,
      priority,
      reason,
      status:           initialStatus,
      assignedDoctorId: isReview ? assignedDoctorId : null,
      addedBy:          req.user.name || 'Unknown',
    });

    // Re-fetch with joins for the response
    const full = await Queue.findByPk(item.id, { include: queueIncludes });

    // Position only applies to Awaiting Triage items; review visits go to Awaiting Doctor
    let position = null;
    if (initialStatus === 'Awaiting Triage') {
      const waitingItems = await Queue.findAll({
        where:      { status: 'Awaiting Triage' },
        order:      [['priority', 'DESC'], ['createdAt', 'ASC']],
        attributes: ['id'],
      });
      position = waitingItems.findIndex(w => w.id === item.id) + 1;
    }

    broadcast('queue_updated');
    return success(res, formatItem(full, position), 201);
  } catch (err) {
    console.error('Queue add error:', err);
    return error(res, 'Internal server error', 500);
  }
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
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const items = await Queue.findAll({
      where: {
        [Op.or]: [
          { status: { [Op.notIn]: ['Completed', 'Removed'] } },          // all active — any date
          { status: 'Completed', createdAt: { [Op.gte]: startOfToday } }, // today's discharged
        ],
      },
      include: queueIncludes,
      order:   [['priority', 'DESC'], ['createdAt', 'ASC']], // Urgent first, then arrival
    });

    // Assign sequential positions only to Waiting items (already in correct order)
    let waitingPos = 0;
    const formatted = items.map(item => {
      if (item.status === 'Awaiting Triage') {
        waitingPos++;
        return formatItem(item, waitingPos);
      }
      return formatItem(item, null);
    });

    return success(res, formatted);
  } catch (err) {
    console.error('Queue list error:', err);
    return error(res, 'Internal server error', 500);
  }
};

// ------------------------------------
// PUT /api/queue/:id — update status or assign doctor
// ------------------------------------
const update = async (req, res) => {
  try {
    const item = await Queue.findByPk(req.params.id);
    if (!item) return error(res, 'Queue item not found', 404);

    // Strip response-only computed fields — not DB columns
    const { assignedDoctorName, ...updates } = req.body;

    // Auto-set timestamps on status transitions
    if (updates.status === 'In Triage') {
      updates.triagedBy       = req.user.name || 'Unknown';
      updates.triageStartTime = new Date();
    }
    // Capture when triage ends — any transition away from 'In Triage'
    if (item.status === 'In Triage' && updates.status && updates.status !== 'In Triage') {
      updates.triageEndTime = new Date();
    }
    // Doctor starts consulting — open a new session entry.
    // For referred patients, item.consultationStartTime is already set by the referring doctor,
    // so we check whether the last session is still open rather than whether one exists at all.
    const lastSessionOpen = Array.isArray(item.consultationSessions) &&
      item.consultationSessions.some(s => !s.endTime);
    if (updates.consultationStartTime && (!item.consultationStartTime || !lastSessionOpen)) {
      updates.consultationSessions = pushSession(item, req.user.id, req.user.name);
    }
    // Consultation ends at billing — record the end time and close the open session.
    if (updates.status === 'Pending Billing') {
      updates.consultationEndTime  = new Date();
      updates.consultationSessions = closeLastSession(item);
    }
    if (updates.status === 'Completed') {
      // Only set consultationEndTime if not already captured at 'Pending Billing'.
      // The previous bug was: updates.consultationEndTime || new Date() — this always
      // overwrote the correct end time with the billing completion time.
      if (!item.consultationEndTime) updates.consultationEndTime = new Date();
      updates.consultationSessions = closeLastSession(item);
      updates.dischargedBy         = req.user.name || 'Unknown';
      updates.dischargedAt         = new Date();
    }

    await item.update(updates);

    // Re-fetch with joins
    const updated = await Queue.findByPk(item.id, { include: queueIncludes });
    broadcast('queue_updated');
    return success(res, formatItem(updated, null));
  } catch (err) {
    console.error('Queue update error:', err);
    return error(res, 'Internal server error', 500);
  }
};

// ------------------------------------
// DELETE /api/queue/:id — soft-remove from queue (keeps record for audit)
// ------------------------------------
const remove = async (req, res) => {
  try {
    const item = await Queue.findByPk(req.params.id);
    if (!item) return error(res, 'Queue item not found', 404);

    await item.update({
      status:        'Removed',
      removedBy:     req.user.name || 'Unknown',
      removalReason: req.body.reason || null,
      dischargedAt:  new Date(),
    });

    broadcast('queue_updated');
    return success(res, { message: 'Patient removed from queue' });
  } catch (err) {
    console.error('Queue remove error:', err);
    return error(res, 'Internal server error', 500);
  }
};

// ------------------------------------
// GET /api/queue/stats — queue statistics
// ------------------------------------
const stats = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayFilter = { createdAt: { [Op.gte]: startOfToday } };

    const [total, waiting, inTriage, withDoctor, pendingBilling, completed, urgent] =
      await Promise.all([
        Queue.count({ where: todayFilter }),
        Queue.count({ where: { status: 'Awaiting Triage', ...todayFilter } }),
        Queue.count({ where: { status: 'In Triage', ...todayFilter } }),
        Queue.count({ where: { status: 'With Doctor', ...todayFilter } }),
        Queue.count({ where: { status: 'Pending Billing', ...todayFilter } }),
        Queue.count({ where: { status: 'Completed', ...todayFilter } }),
        Queue.count({ where: { priority: 'Urgent', ...todayFilter } }),
      ]);

    return success(res, { total, waiting, inTriage, withDoctor, pendingBilling, completed, urgent });
  } catch (err) {
    console.error('Queue stats error:', err);
    return error(res, 'Internal server error', 500);
  }
};

// ------------------------------------
// POST /api/queue/call-next — doctor pulls the next waiting patient
// ------------------------------------
const callNext = async (req, res) => {
  try {
    // First Waiting item: Urgent patients before Normal, oldest first within each
    const next = await Queue.findOne({
      where:   { status: 'Awaiting Triage' },
      order:   [['priority', 'DESC'], ['createdAt', 'ASC']],
      include: queueIncludes,
    });

    if (!next) return error(res, 'No patients waiting', 404);

    await next.update({ status: 'With Doctor' });

    // Re-fetch after update
    const updated = await Queue.findByPk(next.id, { include: queueIncludes });
    broadcast('queue_updated');
    return success(res, formatItem(updated, null));
  } catch (err) {
    console.error('Queue callNext error:', err);
    return error(res, 'Internal server error', 500);
  }
};

// ------------------------------------
// POST /api/queue/:id/refer — doctor refers a patient to another doctor
// ------------------------------------
// Internal referral: reassigns the queue entry to a new doctor (status → Awaiting Doctor).
// External referral: closes the consultation and sends the patient to billing (status → Pending Billing).
// In both cases, a full audit trail is written to the queue record.
// ------------------------------------
const refer = async (req, res) => {
  try {
    const {
      referralType,
      referralReason,
      referredToDoctorId,     // required for Internal
      referredToDoctorName,   // required for Internal — stored as string for permanent record
      externalReferralTarget, // required for External
      selectedCharges    = [],
      selectedProcedures = [],
    } = req.body;

    // --- Validate referralType ---
    if (!referralType || !['Internal', 'External'].includes(referralType)) {
      return error(res, 'referralType must be "Internal" or "External"', 400);
    }

    // --- Validate type-specific required fields ---
    if (referralType === 'Internal' && !referredToDoctorId) {
      return error(res, 'referredToDoctorId is required for an Internal referral', 400);
    }
    if (referralType === 'External' && !externalReferralTarget) {
      return error(res, 'externalReferralTarget is required for an External referral', 400);
    }

    const item = await Queue.findByPk(req.params.id);
    if (!item) return error(res, 'Queue item not found', 404);

    // Only allow referral while the doctor is actively consulting the patient
    if (item.status !== 'With Doctor') {
      return error(res, 'Referral can only be made while the patient status is "With Doctor"', 400);
    }

    // --- Merge charges with any already recorded on this queue entry ---
    // This handles multi-doctor visits: Doctor A's charges are preserved when
    // Doctor B later completes their own consultation and adds their own charges.
    const mergedCharges = [
      ...new Set([...(item.selectedCharges || []), ...selectedCharges]),
    ];
    const mergedProcedures = [
      ...new Set([...(item.selectedProcedures || []), ...selectedProcedures]),
    ];

    // --- Build the shared audit fields (same for both types) ---
    const auditFields = {
      referralType,
      referralReason:       referralReason || null,
      referredByDoctorName: req.user.name  || 'Unknown',
      referredAt:           new Date(),
      selectedCharges:      mergedCharges,
      selectedProcedures:   mergedProcedures,
    };

    // --- Build the type-specific status transition fields ---
    // In both cases: close the referring doctor's open session before handing off.
    const sessionsAfterReferral = closeLastSession(item);

    const transitionFields = referralType === 'Internal'
      ? {
          // Hand off to a different doctor — Doctor B will open a fresh session when they start.
          status:                  'Awaiting Doctor',
          assignedDoctorId:        referredToDoctorId,
          referredToDoctorName:    referredToDoctorName || null,
          consultationEndTime:     new Date(),
          consultationSessions:    sessionsAfterReferral,
        }
      : {
          // Send patient to billing.
          status:                  'Pending Billing',
          externalReferralTarget:  externalReferralTarget,
          consultationEndTime:     new Date(),
          consultationSessions:    sessionsAfterReferral,
        };

    await item.update({ ...auditFields, ...transitionFields });

    const updated = await Queue.findByPk(item.id, { include: queueIncludes });
    broadcast('queue_updated');
    return success(res, formatItem(updated, null));
  } catch (err) {
    console.error('Queue refer error:', err);
    return error(res, 'Internal server error', 500);
  }
};

module.exports = { add, list, update, remove, stats, callNext, refer };
