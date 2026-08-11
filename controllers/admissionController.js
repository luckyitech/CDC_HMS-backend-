const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { broadcast } = require('../utils/sseManager');
const { accrueBedDays } = require('../utils/inpatientBilling');
const db = require('../models');

const {
  sequelize, Admission, BedAssignment, Bed, Ward, Room,
  Queue, Patient, User, DischargeSummary,
} = db;

const admissionIncludes = [
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName', 'isInpatient'] },
  { model: Ward, attributes: ['id', 'name', 'code', 'type'] },
  { model: Room, attributes: ['id', 'name'] },
  { model: Bed, attributes: ['id', 'label', 'status'] },
  { model: User, as: 'admittingDoctor', attributes: ['firstName', 'lastName'] },
  { model: User, as: 'attendingDoctor', attributes: ['firstName', 'lastName'] },
];

// ====================================
// STEP 1 — Doctor advises admission (from the OPD consultation)
// ====================================
exports.requestAdmission = async (req, res) => {
  try {
    const {
      queueId, admissionReason, admissionType, admissionWardPreference,
      selectedCharges = [], selectedProcedures = [],
    } = req.body;
    const queueItem = await Queue.findByPk(queueId, { include: [Patient] });
    if (!queueItem) return error(res, 'Queue item not found', 404);
    if (!queueItem.Patient) return error(res, 'Queue item has no patient', 400);

    const family = await resolvePatient(queueItem.Patient.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'Patient record is deactivated (merged)', 400);

    // Merge the doctor's billing selections with anything already on the queue
    // entry — same accumulation the referral flow uses for multi-doctor visits.
    const mergedCharges = [
      ...new Set([...(queueItem.selectedCharges || []), ...selectedCharges]),
    ];
    const mergedProcedures = [
      ...new Set([...(queueItem.selectedProcedures || []), ...selectedProcedures]),
    ];

    await queueItem.update({
      admissionRequested: true,
      admissionReason: admissionReason || null,
      admissionType: admissionType || null,
      admissionWardPreference: admissionWardPreference || null,
      admissionRequestedByDoctorName: req.user.name,
      admissionRequestedAt: new Date(),
      admissionCancelledAt: null,
      admissionCancelReason: null,
      selectedCharges: mergedCharges,
      selectedProcedures: mergedProcedures,
      status: 'Pending Billing',
    });

    broadcast('queue_updated');
    // Report what was actually stored, not what we asked for. This used to
    // return a hardcoded `true`, which meant the one bug that mattered — the
    // flag being silently dropped before it reached the database — looked like
    // a success all the way back to the doctor's toast.
    return success(res, {
      queueId: queueItem.id,
      admissionRequested: queueItem.admissionRequested,
    });
  } catch (err) {
    console.error('Admission.requestAdmission error:', err);
    return error(res, 'Failed to request admission', 500);
  }
};

exports.cancelAdmissionRequest = async (req, res) => {
  try {
    const { queueId, reason } = req.body;
    const queueItem = await Queue.findByPk(queueId);
    if (!queueItem) return error(res, 'Queue item not found', 404);
    if (queueItem.admissionConvertedToId) {
      return error(res, 'Already converted to an admission; cannot cancel the request', 409);
    }
    await queueItem.update({
      admissionRequested: false,
      admissionCancelledAt: new Date(),
      admissionCancelReason: reason || null,
    });
    broadcast('queue_updated');
    return success(res, { queueId: queueItem.id, cancelled: true });
  } catch (err) {
    console.error('Admission.cancelAdmissionRequest error:', err);
    return error(res, 'Failed to cancel admission request', 500);
  }
};

// ====================================
// STEP 2 — Front desk converts OPD -> inpatient (TRANSACTIONAL)
// ====================================
exports.convert = async (req, res) => {
  const {
    queueId, bedId, admissionType, admissionReason,
    provisionalDiagnosis, opdBilling,
  } = req.body;
  if (!queueId || !bedId) return error(res, 'queueId and bedId are required', 400);

  try {
    const result = await sequelize.transaction(async (t) => {
      const queueItem = await Queue.findByPk(queueId, { include: [Patient], transaction: t });
      if (!queueItem) throw { code: 404, msg: 'Queue item not found' };
      if (queueItem.admissionConvertedToId) throw { code: 409, msg: 'Already converted' };

      const family = await resolvePatient(queueItem.Patient.uhid);
      if (!family) throw { code: 404, msg: 'Patient not found' };
      if (family.isDeactivated) throw { code: 400, msg: 'Patient record is deactivated (merged)' };

      // Lock the bed row — this is what makes two concurrent converts safe.
      const bed = await Bed.findByPk(bedId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!bed) throw { code: 404, msg: 'Bed not found' };
      if (bed.status !== 'Available') throw { code: 409, msg: 'Bed is no longer available' };

      await bed.update({ status: 'Occupied' }, { transaction: t });

      const now = new Date();
      const admission = await Admission.create({
        PatientId: family.patient.id,
        WardId: bed.WardId,
        RoomId: bed.RoomId,
        BedId: bed.id,
        admittingDoctorId: queueItem.assignedDoctorId || null,
        attendingDoctorId: queueItem.assignedDoctorId || null,
        admissionDateTime: now,
        admissionReason: admissionReason || queueItem.admissionReason || null,
        provisionalDiagnosis: provisionalDiagnosis || null,
        admissionType: admissionType || queueItem.admissionType || 'Elective',
        admissionSource: 'OPD',
        status: 'Admitted',
        fromQueueId: queueItem.id,
        admittedById: req.user.id,
        opdBillingMode: opdBilling === 'merge' ? 'merge' : 'clear',
      }, { transaction: t });

      await BedAssignment.create({
        AdmissionId: admission.id,
        BedId: bed.id,
        WardId: bed.WardId,
        fromDateTime: now,
        reason: 'Admission',
        movedById: req.user.id,
      }, { transaction: t });

      await queueItem.update({
        status: 'Completed',
        admissionConvertedToId: admission.id,
        dischargedBy: req.user.name,
        dischargedAt: now,
      }, { transaction: t });

      await Patient.update({ isInpatient: true }, { where: { id: family.patient.id }, transaction: t });

      return admission;
    });

    broadcast('queue_updated');
    broadcast('board_updated');
    return success(res, { admissionId: result.id }, 201);
  } catch (err) {
    if (err && err.code) return error(res, err.msg, err.code);
    console.error('Admission.convert error:', err);
    return error(res, 'Failed to convert to inpatient', 500);
  }
};

// Direct admission with no OPD queue item (transfer-in / walk-in)
exports.directAdmit = async (req, res) => {
  const { uhid, bedId, admissionType, admissionSource, admissionReason, provisionalDiagnosis, admittingDoctorId } = req.body;
  if (!uhid || !bedId) return error(res, 'uhid and bedId are required', 400);
  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'Patient record is deactivated (merged)', 400);

    const result = await sequelize.transaction(async (t) => {
      const bed = await Bed.findByPk(bedId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!bed) throw { code: 404, msg: 'Bed not found' };
      if (bed.status !== 'Available') throw { code: 409, msg: 'Bed is no longer available' };
      await bed.update({ status: 'Occupied' }, { transaction: t });

      const now = new Date();
      const admission = await Admission.create({
        PatientId: family.patient.id,
        WardId: bed.WardId, RoomId: bed.RoomId, BedId: bed.id,
        admittingDoctorId: admittingDoctorId || null,
        attendingDoctorId: admittingDoctorId || null,
        admissionDateTime: now,
        admissionReason: admissionReason || null,
        provisionalDiagnosis: provisionalDiagnosis || null,
        admissionType: admissionType || 'Elective',
        admissionSource: admissionSource || 'Walk-in',
        status: 'Admitted',
        admittedById: req.user.id,
      }, { transaction: t });

      await BedAssignment.create({
        AdmissionId: admission.id, BedId: bed.id, WardId: bed.WardId,
        fromDateTime: now, reason: 'Admission', movedById: req.user.id,
      }, { transaction: t });

      await Patient.update({ isInpatient: true }, { where: { id: family.patient.id }, transaction: t });
      return admission;
    });

    broadcast('board_updated');
    return success(res, { admissionId: result.id }, 201);
  } catch (err) {
    if (err && err.code) return error(res, err.msg, err.code);
    console.error('Admission.directAdmit error:', err);
    return error(res, 'Failed to admit patient', 500);
  }
};

// ====================================
// READS
// ====================================
// Save the admission NOTE to the record ("Save & Print"), per protocol — WITHOUT
// requesting admission or moving the visit to billing. The doctor can then send
// for admission (requestAdmission) or cancel and keep working. Idempotent: writes
// the latest note onto the open queue row.
exports.saveNote = async (req, res) => {
  try {
    const { queueId, admissionReason, admissionType } = req.body;
    if (!admissionReason || !admissionReason.trim()) return error(res, 'The admission note is empty.', 400);

    const queueItem = await Queue.findByPk(queueId, { include: [Patient] });
    if (!queueItem) return error(res, 'Queue item not found', 404);
    if (!queueItem.Patient) return error(res, 'Queue item has no patient', 400);

    const family = await resolvePatient(queueItem.Patient.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'Patient record is deactivated (merged)', 400);

    await queueItem.update({
      admissionReason,
      admissionType: admissionType || queueItem.admissionType || null,
      admissionRequestedByDoctorName: req.user.name,
      admissionRequestedAt: queueItem.admissionRequestedAt || new Date(),
    });

    return success(res, { queueId: queueItem.id, saved: true });
  } catch (err) {
    console.error('Admission.saveNote error:', err);
    return error(res, 'Failed to save admission note', 500);
  }
};

// Advised admissions for one patient — the admission NOTES a doctor wrote from
// the OPD consultation (stored on the queue row), merge-aware. Feeds the Visit
// History "Actions" tab. Read-only.
exports.listAdvised = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'uhid is required', 400);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const rows = await Queue.findAll({
      // Any queue row that carries an admission NOTE — whether the doctor only
      // documented it ("Save & Print") or went on to send for admission.
      where: { PatientId: { [Op.in]: family.patientIds }, admissionReason: { [Op.ne]: null } },
      attributes: [
        'id', 'admissionType', 'admissionReason', 'admissionWardPreference',
        'admissionRequestedByDoctorName', 'admissionRequestedAt',
        'admissionCancelledAt', 'admissionConvertedToId',
      ],
      order: [['admissionRequestedAt', 'DESC']],
    });

    const admissions = rows.map((q) => ({
      id: q.id,
      admissionType: q.admissionType,
      note: q.admissionReason,
      doctorName: q.admissionRequestedByDoctorName,
      requestedAt: q.admissionRequestedAt,
      cancelledAt: q.admissionCancelledAt,
      converted: !!q.admissionConvertedToId,
    }));

    return success(res, { admissions });
  } catch (err) {
    console.error('Admission.listAdvised error:', err);
    return error(res, 'Failed to load advised admissions', 500);
  }
};

exports.list = async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    else where.status = { [Op.in]: ['Admitted', 'OnLeave'] }; // active by default
    if (req.query.wardId) where.WardId = req.query.wardId;
    if (req.query.doctorId) where.attendingDoctorId = req.query.doctorId;

    const admissions = await Admission.findAll({
      where,
      include: admissionIncludes,
      order: [['admissionDateTime', 'DESC']],
    });
    return success(res, admissions);
  } catch (err) {
    console.error('Admission.list error:', err);
    return error(res, 'Failed to load admissions', 500);
  }
};

exports.getById = async (req, res) => {
  try {
    const admission = await Admission.findByPk(req.params.id, {
      include: [
        ...admissionIncludes,
        {
          model: BedAssignment,
          include: [{ model: Bed, attributes: ['label'] }, { model: Ward, attributes: ['name'] }],
        },
      ],
      order: [[BedAssignment, 'fromDateTime', 'ASC']],
    });
    if (!admission) return error(res, 'Admission not found', 404);
    return success(res, admission);
  } catch (err) {
    console.error('Admission.getById error:', err);
    return error(res, 'Failed to load admission', 500);
  }
};

// ====================================
// TRANSFER (TRANSACTIONAL)
// ====================================
exports.transfer = async (req, res) => {
  const { bedId, reason } = req.body;
  if (!bedId) return error(res, 'bedId is required', 400);
  try {
    await sequelize.transaction(async (t) => {
      const admission = await Admission.findByPk(req.params.id, { transaction: t });
      if (!admission) throw { code: 404, msg: 'Admission not found' };
      if (admission.status !== 'Admitted') throw { code: 400, msg: 'Admission is not active' };

      const newBed = await Bed.findByPk(bedId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!newBed) throw { code: 404, msg: 'Target bed not found' };
      if (newBed.status !== 'Available') throw { code: 409, msg: 'Target bed is no longer available' };

      const now = new Date();

      // Free the old bed
      if (admission.BedId) {
        const oldBed = await Bed.findByPk(admission.BedId, { transaction: t });
        if (oldBed) await oldBed.update({ status: 'Cleaning' }, { transaction: t });
      }
      // Close current assignment
      await BedAssignment.update(
        { toDateTime: now },
        { where: { AdmissionId: admission.id, toDateTime: null }, transaction: t }
      );
      // Occupy new bed + open new assignment
      await newBed.update({ status: 'Occupied' }, { transaction: t });
      await BedAssignment.create({
        AdmissionId: admission.id, BedId: newBed.id, WardId: newBed.WardId,
        fromDateTime: now, reason: reason ? `Transfer: ${reason}` : 'Transfer', movedById: req.user.id,
      }, { transaction: t });

      await admission.update(
        { BedId: newBed.id, RoomId: newBed.RoomId, WardId: newBed.WardId },
        { transaction: t }
      );
    });

    broadcast('board_updated');
    return success(res, { transferred: true });
  } catch (err) {
    if (err && err.code) return error(res, err.msg, err.code);
    console.error('Admission.transfer error:', err);
    return error(res, 'Failed to transfer patient', 500);
  }
};

// ====================================
// REASSIGN ATTENDING DOCTOR
// ====================================
exports.reassignAttending = async (req, res) => {
  try {
    const { attendingDoctorId } = req.body;
    if (!attendingDoctorId) return error(res, 'attendingDoctorId is required', 400);
    const admission = await Admission.findByPk(req.params.id);
    if (!admission) return error(res, 'Admission not found', 404);
    const prev = admission.attendingDoctorId;
    await admission.update({ attendingDoctorId });
    console.log(`Admission.reassignAttending: admission ${admission.id} attending ${prev} -> ${attendingDoctorId} by user ${req.user.id}`);
    broadcast('board_updated');
    return success(res, { attendingDoctorId });
  } catch (err) {
    console.error('Admission.reassignAttending error:', err);
    return error(res, 'Failed to reassign attending doctor', 500);
  }
};

// ====================================
// DISCHARGE — gated on a signed DischargeSummary (Phase 4). TRANSACTIONAL.
// ====================================
exports.discharge = async (req, res) => {
  try {
    await sequelize.transaction(async (t) => {
      const admission = await Admission.findByPk(req.params.id, { transaction: t });
      if (!admission) throw { code: 404, msg: 'Admission not found' };
      if (admission.status !== 'Admitted' && admission.status !== 'OnLeave') {
        throw { code: 400, msg: 'Admission is not active' };
      }

      const summary = await DischargeSummary.findOne({
        where: { AdmissionId: admission.id }, transaction: t,
      });
      if (!summary || summary.status !== 'signed') {
        throw { code: 409, msg: 'A signed discharge summary is required before discharge' };
      }

      const now = new Date();
      const statusMap = {
        Routine: 'Discharged', AgainstAdvice: 'Discharged',
        Referred: 'Transferred', Deceased: 'Deceased', Absconded: 'Absconded',
      };
      const newStatus = statusMap[summary.dischargeType] || 'Discharged';
      const losHours = Math.round((now - new Date(admission.admissionDateTime)) / (1000 * 60 * 60));

      // Accrue bed-days up to discharge (per midnight crossed), at the ward rate
      const ward = admission.WardId ? await Ward.findByPk(admission.WardId, { transaction: t }) : null;
      await accrueBedDays(admission, now, req.user.id, t, ward ? ward.ratePerDay : 0);

      // Free the bed
      if (admission.BedId) {
        const bed = await Bed.findByPk(admission.BedId, { transaction: t });
        if (bed) await bed.update({ status: 'Cleaning' }, { transaction: t });
      }
      await BedAssignment.update(
        { toDateTime: now },
        { where: { AdmissionId: admission.id, toDateTime: null }, transaction: t }
      );

      await admission.update({
        status: newStatus,
        dischargeDateTime: now,
        dischargeType: summary.dischargeType || 'Routine',
        lengthOfStayHours: losHours,
        dischargedById: req.user.id,
      }, { transaction: t });

      await Patient.update({ isInpatient: false }, { where: { id: admission.PatientId }, transaction: t });
    });

    broadcast('board_updated');
    return success(res, { discharged: true });
  } catch (err) {
    if (err && err.code) return error(res, err.msg, err.code);
    console.error('Admission.discharge error:', err);
    return error(res, 'Failed to discharge patient', 500);
  }
};
