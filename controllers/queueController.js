const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const { clinicStartOfDay } = require('../utils/clinicTime');
const db = require('../models');

const { Queue, Patient, User } = db;

// Statuses in which the patient is with nursing, not a doctor. Leaving one of
// these for 'Awaiting Doctor' is the nurse → doctor dispatch (sentToDoctorAt).
const NURSE_FACING_STATUSES = ['Awaiting Triage', 'In Triage', 'Pending Injection'];

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

// JSON-array columns come back parsed on MySQL 8 but as raw strings on MariaDB
// (mysql2 leaves LONGTEXT-backed JSON alone). Downstream code spreads these
// arrays to merge charges — spreading a string splits it into characters and
// writes a corrupted bill back. Normalise once, here, whatever the driver did.
const jsonArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

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
    destination:           q.destination || 'Outpatient',
    service:               q.service || null,
    estimatedWait:         position !== null ? `${position * 15} min` : null,
    assignedDoctorId:      q.assignedDoctorId,
    assignedDoctorName:    q.assignedDoctor
                             ? `Dr. ${q.assignedDoctor.firstName} ${q.assignedDoctor.lastName}`
                             : null,
    triageStartTime:        q.triageStartTime        || null,
    triageEndTime:          q.triageEndTime          || null,
    sentToDoctorAt:         q.sentToDoctorAt         || null,
    consultationStartTime:  q.consultationStartTime  || null,
    consultationEndTime:    q.consultationEndTime    || null,
    consultationSessions:   jsonArray(q.consultationSessions),
    selectedCharges:       jsonArray(q.selectedCharges),
    selectedProcedures:    jsonArray(q.selectedProcedures),
    doctorNotes:           q.doctorNotes           || null,
    finalCharges:          jsonArray(q.finalCharges),
    finalProcedures:       jsonArray(q.finalProcedures),
    finalSupplies:         jsonArray(q.finalSupplies),
    dischargeComment:      q.dischargeComment      || null,
    addedBy:               q.addedBy               || null,
    triagedBy:             q.triagedBy             || null,
    dischargedBy:          q.dischargedBy          || null,
    dischargedAt:          q.dischargedAt          || null,
    removedBy:             q.removedBy             || null,
    removalReason:         q.removalReason         || null,
    // Referral audit trail — null on non-referred entries
    referralType:           q.referralType          || null,
    referralReason:         q.referralReason        || null,
    referredByDoctorName:   q.referredByDoctorName  || null,
    referredAt:             q.referredAt            || null,
    referredToDoctorName:   q.referredToDoctorName  || null,
    externalReferralTarget: q.externalReferralTarget|| null,
    // HMIS V3 — admission request (advise -> convert)
    admissionRequested:             q.admissionRequested             || false,
    admissionReason:                q.admissionReason                || null,
    admissionType:                  q.admissionType                  || null,
    admissionWardPreference:        q.admissionWardPreference        || null,
    admissionRequestedByDoctorName: q.admissionRequestedByDoctorName || null,
    admissionRequestedAt:           q.admissionRequestedAt           || null,
    admissionConvertedToId:         q.admissionConvertedToId         || null,
  };
};

// ------------------------------------
// POST /api/queue — add patient to queue
// ------------------------------------
const add = async (req, res) => {
  try {
    const { uhid, priority = 'Normal', reason, isReview = false, assignedDoctorId = null,
            destination = 'Outpatient', service = null } = req.body;

    const VALID_DESTINATIONS = ['Outpatient', 'Inpatient', 'Radiology', 'Pharmacy'];
    if (!VALID_DESTINATIONS.includes(destination)) {
      return error(res, 'Invalid destination', 400);
    }
    // Inpatient admissions are created directly against a bed (POST /admissions/direct),
    // never as a queue row. Guard so the two paths can't diverge.
    if (destination === 'Inpatient') {
      return error(res, 'Use the admissions flow for inpatient admissions', 400);
    }

    const { resolvePatient } = require('../utils/patientFamily');
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. They cannot be added to the queue.', 403);
    const patient = family.patient;

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
      const startOfToday = clinicStartOfDay();
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
      destination,
      service:          destination === 'Radiology' ? service : null,
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
    const startOfToday = clinicStartOfDay();

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
    // Triage end is normally stamped when vitals are saved for the visit
    // (patientController.recordVitals). Leaving 'In Triage' is the fallback for
    // a row that was opened but never had vitals saved — never overwrite the
    // real end time with the later departure time.
    if (item.status === 'In Triage' && updates.status && updates.status !== 'In Triage' && !item.triageEndTime) {
      updates.triageEndTime = new Date();
    }
    // Nurse → doctor dispatch. Only from a nurse-facing status: a doctor's
    // internal referral and the nurse's "add to bill" merge also send
    // 'Awaiting Doctor' (from 'With Doctor' / 'Awaiting Doctor') and must not
    // stamp this. Never overwritten.
    if (updates.status === 'Awaiting Doctor' && NURSE_FACING_STATUSES.includes(item.status) && !item.sentToDoctorAt) {
      updates.sentToDoctorAt = new Date();
    }
    // Doctor starts consulting — open a new session entry.
    // For referred patients, item.consultationStartTime is already set by the referring doctor,
    // so we check whether the last session is still open rather than whether one exists at all.
    const lastSessionOpen = Array.isArray(item.consultationSessions) &&
      item.consultationSessions.some(s => !s.endTime);
    if (updates.consultationStartTime && (!item.consultationStartTime || !lastSessionOpen)) {
      updates.consultationSessions = pushSession(item, req.user.id, req.user.name);
    }
    // The consultation ends whenever the patient leaves the doctor — whether
    // that is to billing, or back to the nurse for an injection. Keying off the
    // departure rather than the destination means new routes get correct
    // timings for free.
    if (item.status === 'With Doctor' && updates.status && updates.status !== 'With Doctor') {
      updates.consultationEndTime  = new Date();
      updates.consultationSessions = closeLastSession(item);
    }
    if (updates.status === 'Completed') {
      // Only set consultationEndTime if not already captured on the way out of
      // 'With Doctor'. The previous bug was: updates.consultationEndTime || new Date()
      // — this always overwrote the correct end time with the completion time.
      if (!item.consultationEndTime && !updates.consultationEndTime) updates.consultationEndTime = new Date();
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
    const startOfToday = clinicStartOfDay();
    const todayFilter = { createdAt: { [Op.gte]: startOfToday } };

    const [total, waiting, inTriage, withDoctor, pendingInjection, pendingBilling, completed, urgent] =
      await Promise.all([
        Queue.count({ where: todayFilter }),
        Queue.count({ where: { status: 'Awaiting Triage', ...todayFilter } }),
        Queue.count({ where: { status: 'In Triage', ...todayFilter } }),
        Queue.count({ where: { status: 'With Doctor', ...todayFilter } }),
        Queue.count({ where: { status: 'Pending Injection', ...todayFilter } }),
        Queue.count({ where: { status: 'Pending Billing', ...todayFilter } }),
        Queue.count({ where: { status: 'Completed', ...todayFilter } }),
        Queue.count({ where: { priority: 'Urgent', ...todayFilter } }),
      ]);

    return success(res, { total, waiting, inTriage, withDoctor, pendingInjection, pendingBilling, completed, urgent });
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
      referralNote,           // full letter body — persisted for Visit History / letterhead
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
      // Persist the note so it lands in Visit History Actions even when the
      // doctor sent the referral without clicking Save & Print first. The empty
      // branch below is what keeps a previously-saved note when this submit
      // didn't carry one; when it DID, the text is current, so the timestamp
      // must be too — an edited letter stamped with the earlier save time reads
      // as a document that was never changed.
      ...(referralNote && referralNote.trim()
        ? {
            referralNote,
            referralNoteSavedAt:      new Date(),
            referralNoteByDoctorName: req.user.name || 'Unknown',
          }
        : {}),
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

// ------------------------------------
// POST /api/queue/:id/refer-note — Save & Print the referral NOTE (no handoff)
// ------------------------------------
// Documents the referral note per protocol WITHOUT finalising the referral or
// moving the visit to billing. The doctor can then send the referral (refer) or
// keep working. Mirrors the admission saveNote pattern. Merge-aware read guard.
// Idempotent: writes the latest note onto the open queue row.
//
// This endpoint must never touch the referral's own audit fields. On an INTERNAL
// referral the queue row is handed to a second doctor, who then consults with
// status 'With Doctor' — so a naive note save would overwrite referredByDoctorName
// with the RECEIVING doctor while leaving referredAt at the original time, erasing
// who made the referral and making an unsent draft read as a sent referral.
const saveReferralNote = async (req, res) => {
  try {
    const { referralNote, referralType } = req.body;
    if (!referralNote || !referralNote.trim()) return error(res, 'The referral note is empty.', 400);

    // referralType lands in an ENUM column. Sequelize does not check ENUM
    // membership, so an unexpected value reaches MySQL: a 500 under STRICT mode,
    // or a silently blanked clinical field without it.
    if (referralType && !['Internal', 'External'].includes(referralType)) {
      return error(res, 'referralType must be "Internal" or "External"', 400);
    }

    const item = await Queue.findByPk(req.params.id, { include: [Patient] });
    if (!item) return error(res, 'Queue item not found', 404);
    if (!item.Patient) return error(res, 'Queue item has no patient', 400);

    // Same guard refer() applies: a note may only be written while the doctor is
    // actively consulting. Without it any doctor can write onto any queue row by
    // id, including a visit that is already billed or completed.
    if (item.status !== 'With Doctor') {
      return error(res, 'A referral note can only be saved while the patient status is "With Doctor"', 400);
    }

    // The referral on this row is already final. One queue row carries one
    // referral, so a further note here would be filed under someone else's
    // referral in Visit History. Refuse rather than corrupt the record.
    if (item.referredAt) {
      return error(
        res,
        `This visit was already referred${item.referredByDoctorName ? ` by ${item.referredByDoctorName}` : ''}; a new referral note cannot be saved against it.`,
        409,
      );
    }

    const { resolvePatient } = require('../utils/patientFamily');
    const family = await resolvePatient(item.Patient.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'Patient record is deactivated (merged)', 400);

    await item.update({
      referralNote,
      // The note author — NOT referredByDoctorName, which belongs to refer().
      referralNoteByDoctorName: req.user.name,
      referralNoteSavedAt:      new Date(),
      // Safe: the referredAt guard above means no referral has been finalised on
      // this row, so referralType is still the draft's to set.
      referralType:             referralType || item.referralType || null,
    });

    return success(res, { queueId: item.id, saved: true });
  } catch (err) {
    console.error('Queue.saveReferralNote error:', err);
    return error(res, 'Failed to save referral note', 500);
  }
};

// ------------------------------------
// GET /api/queue/advised-referrals?uhid= — referral NOTES for one patient
// ------------------------------------
// The referral notes a doctor documented from the OPD consultation (stored on
// the queue row), merge-aware. Feeds the Visit History "Actions" tab alongside
// admission notes and prescriptions. Read-only.
const listAdvisedReferrals = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'uhid is required', 400);

    const { resolvePatient } = require('../utils/patientFamily');
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const rows = await Queue.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, referralNote: { [Op.ne]: null } },
      attributes: [
        'id', 'referralType', 'referralNote', 'referredToDoctorName',
        'externalReferralTarget', 'referredByDoctorName', 'referralNoteByDoctorName',
        'referralNoteSavedAt', 'referredAt',
      ],
      order: [['referralNoteSavedAt', 'DESC']],
    });

    const referrals = rows.map((q) => ({
      id: q.id,
      referralType: q.referralType,
      destination: q.referredToDoctorName || q.externalReferralTarget || null,
      note: q.referralNote,
      // The note's author. Falls back to referredByDoctorName for rows written
      // before referralNoteByDoctorName existed, and for notes captured by
      // refer() itself (where the two are the same doctor anyway).
      doctorName: q.referralNoteByDoctorName || q.referredByDoctorName,
      savedAt: q.referralNoteSavedAt,
      // referredAt is only set once the referral is finalised; null while advised.
      sent: !!q.referredAt,
    }));

    return success(res, { referrals });
  } catch (err) {
    console.error('Queue.listAdvisedReferrals error:', err);
    return error(res, 'Failed to load referral notes', 500);
  }
};

// ------------------------------------
// GET /api/queue/patient/:uhid — the patient's visit workflow history: the
// queue-milestone timestamps (check-in, triage, doctor, completion) for every
// visit. Merge-aware. Feeds the Visit Timeline in Visit History.
// ------------------------------------
const patientHistory = async (req, res) => {
  try {
    const { uhid } = req.params;
    if (!uhid) return error(res, 'uhid is required', 400);

    const { resolvePatient } = require('../utils/patientFamily');
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const rows = await Queue.findAll({
      where: { PatientId: { [Op.in]: family.patientIds } },
      attributes: [
        'id', 'status', 'createdAt',
        'triageStartTime', 'triageEndTime', 'triagedBy', 'sentToDoctorAt',
        'consultationStartTime', 'consultationEndTime',
        'consultationSessions', 'referredAt', 'dischargedAt', 'dischargedBy',
      ],
      order: [['createdAt', 'ASC']],
    });

    const visits = rows.map((q) => ({
      id:                    q.id,
      status:                q.status,
      checkedInAt:           q.createdAt,
      triageStartTime:       q.triageStartTime,
      triageEndTime:         q.triageEndTime,
      triagedBy:             q.triagedBy,          // name snapshot from the JWT at triage
      sentToDoctorAt:        q.sentToDoctorAt,     // nurse → doctor dispatch
      consultationStartTime: q.consultationStartTime,
      consultationEndTime:   q.consultationEndTime,
      // [{ doctorId, doctorName, startTime, endTime }] — one per doctor seen.
      doctorSessions:        Array.isArray(q.consultationSessions) ? q.consultationSessions : [],
      referredAt:            q.referredAt,
      dischargedAt:          q.dischargedAt,
      dischargedBy:          q.dischargedBy,
    }));

    return success(res, { visits });
  } catch (err) {
    console.error('Queue.patientHistory error:', err);
    return error(res, 'Failed to load visit workflow history', 500);
  }
};

module.exports = { add, list, update, remove, stats, callNext, refer, saveReferralNote, listAdvisedReferrals, patientHistory };
