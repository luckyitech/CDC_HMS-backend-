const { success, error } = require('../utils/response');
const db = require('../models');

const { WardRoundNote, Admission, User } = db;

exports.create = async (req, res) => {
  try {
    const { admissionId, subjective, objective, assessment, plan, reviewFlag } = req.body;
    const admission = await Admission.findByPk(admissionId);
    if (!admission) return error(res, 'Admission not found', 404);
    const note = await WardRoundNote.create({
      AdmissionId: admission.id,
      PatientId: admission.PatientId,
      doctorId: req.user.id,
      roundDateTime: req.body.roundDateTime || new Date(),
      subjective: subjective || null,
      objective: objective || null,
      assessment: assessment || null,
      plan: plan || null,
      reviewFlag: !!reviewFlag,
    });
    return success(res, note, 201);
  } catch (err) {
    console.error('WardRoundNote.create error:', err);
    return error(res, 'Failed to create ward-round note', 500);
  }
};

exports.list = async (req, res) => {
  try {
    const { admissionId } = req.query;
    if (!admissionId) return error(res, 'admissionId is required', 400);
    const notes = await WardRoundNote.findAll({
      where: { AdmissionId: admissionId, status: ['active', 'amended'] },
      include: [{ model: User, as: 'doctor', attributes: ['firstName', 'lastName'] }],
      order: [['roundDateTime', 'DESC']],
    });
    return success(res, notes);
  } catch (err) {
    console.error('WardRoundNote.list error:', err);
    return error(res, 'Failed to load ward-round notes', 500);
  }
};

// Amend — never destroy. Keeps original text in an amendment stamp.
exports.amend = async (req, res) => {
  try {
    const note = await WardRoundNote.findByPk(req.params.id);
    if (!note) return error(res, 'Note not found', 404);
    await note.update({
      subjective: req.body.subjective ?? note.subjective,
      objective: req.body.objective ?? note.objective,
      assessment: req.body.assessment ?? note.assessment,
      plan: req.body.plan ?? note.plan,
      reviewFlag: req.body.reviewFlag ?? note.reviewFlag,
      status: 'amended',
      amendedById: req.user.id,
      amendedAt: new Date(),
    });
    return success(res, note);
  } catch (err) {
    console.error('WardRoundNote.amend error:', err);
    return error(res, 'Failed to amend note', 500);
  }
};
