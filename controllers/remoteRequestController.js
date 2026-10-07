// Remote requests (6 Oct 2026) — a prescription or lab request written
// OUTSIDE a consultation (phone, WhatsApp, email, walk-in without a visit).
//
//   POST  /api/remote-requests              doctor — start one (channel, who asked, note)
//   GET   /api/remote-requests?uhid=…       clinical roles — this patient's (merge family)
//   PATCH /api/remote-requests/:id/cancel   its author — soft-cancel (kept on record)
//
// The prescription / lab request itself is saved through its own endpoint with
// remoteRequestId; services/remoteRequests.checkLink is the one rule for that.
// Merge-aware: reads span the family, writes go to the canonical patient and
// refuse a deactivated file. The author comes from the JWT.

const { Op } = require('sequelize');
const { RemoteRequest, User } = require('../models');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const R = require('../utils/remoteRequests');

const INCLUDE = [{ model: User, as: 'doctor', attributes: ['id', 'firstName', 'lastName'] }];

const create = async (req, res) => {
  try {
    const family = await resolvePatient(req.body.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const clean = R.cleanRequest(req.body);
    if (!clean.ok) return error(res, clean.message, 400, { code: clean.code });
    const row = await RemoteRequest.create({ ...clean.value, PatientId: family.patient.id, doctorId: req.user.id, status: 'active' });
    const full = await RemoteRequest.findByPk(row.id, { include: INCLUDE });
    return success(res, R.view(full), 201);
  } catch (err) {
    console.error('RemoteRequest.create error:', err);
    return error(res, 'Failed to start the remote request', 500);
  }
};

const listForPatient = async (req, res) => {
  try {
    const family = await resolvePatient(req.query.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const rows = await RemoteRequest.findAll({
      where: { PatientId: { [Op.in]: family.patientIds } },
      include: INCLUDE,
      order: [['createdAt', 'DESC']],
      limit: 500,
    });
    return success(res, rows.map(R.view));
  } catch (err) {
    console.error('RemoteRequest.listForPatient error:', err);
    return error(res, 'Failed to load remote requests', 500);
  }
};

const cancel = async (req, res) => {
  try {
    const row = await RemoteRequest.findByPk(Number(req.params.id));
    if (!row) return error(res, 'Remote request not found', 404);
    if (row.doctorId !== req.user.id) return error(res, 'Only the doctor who wrote it can cancel a remote request.', 403);
    if (row.status === 'cancelled') return success(res, R.view(row));
    await row.update({ status: 'cancelled', cancelledById: req.user.id, cancelledAt: new Date() });
    const full = await RemoteRequest.findByPk(row.id, { include: INCLUDE });
    return success(res, R.view(full));
  } catch (err) {
    console.error('RemoteRequest.cancel error:', err);
    return error(res, 'Failed to cancel the remote request', 500);
  }
};

module.exports = { create, listForPatient, cancel };
