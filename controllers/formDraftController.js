// Autosave drafts (6 Oct 2026) — the author's own unsaved typing.
//
// Every action is scoped to req.user.id: a draft is never shown to anyone but
// its author (not a colleague, not an admin). Patient access is merge-aware —
// reads span the merge family, writes go to the canonical patient and refuse a
// deactivated (merged-away) file. Rules in utils/formDrafts.
//
//   GET    /api/drafts?uhid=…[&formKey=…&contextKey=…]   my drafts for a patient (with payload)
//   GET    /api/drafts/mine                              all my drafts (no payload) — "My drafts"
//   PUT    /api/drafts                                   save (upsert) one draft
//   DELETE /api/drafts?uhid=…&formKey=…[&contextKey=…]   discard / the real save succeeded
//   DELETE /api/drafts/:id                               discard one of mine by id

const { Op, UniqueConstraintError } = require('sequelize');
const { FormDraft, Patient } = require('../models');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const D = require('../utils/formDrafts');

const PATIENT_ATTRS = ['id', 'uhid', 'firstName', 'lastName', 'mergedIntoId'];
const patientView = (p) => (p ? { uhid: p.uhid, name: [p.firstName, p.lastName].filter(Boolean).join(' ') } : null);

const notExpired = () => ({
  updatedAt: { [Op.gt]: new Date(Date.now() - D.DRAFT_LIFETIME_DAYS * 24 * 3600 * 1000) },
});

/** GET /api/drafts?uhid= — my drafts on this patient's file (merge family). */
const listForPatient = async (req, res) => {
  try {
    const uhid = req.query.uhid;
    if (!uhid) return error(res, 'Patient UHID is required', 400);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const where = { userId: req.user.id, PatientId: { [Op.in]: family.patientIds }, ...notExpired() };
    if (req.query.formKey) {
      if (!D.isFormKey(req.query.formKey)) return error(res, 'Unknown form.', 400);
      where.formKey = req.query.formKey;
    }
    if (req.query.contextKey !== undefined) {
      const ctx = D.cleanContextKey(req.query.contextKey);
      if (ctx === null) return error(res, 'Bad draft context.', 400);
      where.contextKey = ctx;
    }
    const rows = await FormDraft.findAll({ where, order: [['updatedAt', 'DESC']] });
    return success(res, rows.map((r) => D.draftView(r)));
  } catch (err) {
    console.error('FormDraft.listForPatient error:', err);
    return error(res, 'Failed to load drafts', 500);
  }
};

/** GET /api/drafts/mine — every draft of mine, newest first, without payloads. */
const listMine = async (req, res) => {
  try {
    const rows = await FormDraft.findAll({
      where: { userId: req.user.id, ...notExpired() },
      include: [{ model: Patient, attributes: PATIENT_ATTRS }],
      order: [['updatedAt', 'DESC']],
      limit: 200,
    });
    // A draft written before its patient was merged points at the old file —
    // show (and open) the canonical one.
    const mergedInto = [...new Set(rows.map((r) => r.Patient?.mergedIntoId).filter(Boolean))];
    const canonical = mergedInto.length
      ? new Map((await Patient.findAll({ where: { id: { [Op.in]: mergedInto } }, attributes: PATIENT_ATTRS }))
        .map((p) => [p.id, p]))
      : new Map();
    const views = rows.map((r) => {
      const p = r.Patient?.mergedIntoId ? canonical.get(r.Patient.mergedIntoId) || r.Patient : r.Patient;
      return D.draftView(r, { withPayload: false, patient: patientView(p) });
    });
    return success(res, views);
  } catch (err) {
    console.error('FormDraft.listMine error:', err);
    return error(res, 'Failed to load drafts', 500);
  }
};

/** PUT /api/drafts — save one draft (create or replace mine). */
const save = async (req, res) => {
  try {
    const family = await resolvePatient(req.body.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);

    const clean = D.cleanSave(req.body);
    if (!clean.ok) return error(res, clean.message, clean.code === 'TOO_LARGE' ? 413 : 400, { code: clean.code });
    const { formKey, contextKey, label, device, payload } = clean.value;

    const key = { userId: req.user.id, formKey, contextKey };
    const fields = { label, device, payload, reminderSentAt: null, PatientId: family.patient.id };
    const findMine = () => FormDraft.findOne({ where: { ...key, PatientId: { [Op.in]: family.patientIds } } });

    let row = await findMine();
    if (row) {
      await row.update(fields);
    } else {
      try {
        row = await FormDraft.create({ ...key, ...fields });
      } catch (e) {
        // Two saves of the same form crossed (two tabs, a retry) — the other
        // one created the row; replace it.
        if (!(e instanceof UniqueConstraintError)) throw e;
        row = await findMine();
        await row.update(fields);
      }
    }
    return success(res, D.draftView(row, { withPayload: false }));
  } catch (err) {
    console.error('FormDraft.save error:', err);
    return error(res, 'Failed to save draft', 500);
  }
};

/** DELETE /api/drafts?uhid=&formKey=[&contextKey=] — discard mine. */
const remove = async (req, res) => {
  try {
    const family = await resolvePatient(req.query.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (!D.isFormKey(req.query.formKey)) return error(res, 'Unknown form.', 400);
    const contextKey = D.cleanContextKey(req.query.contextKey);
    if (contextKey === null) return error(res, 'Bad draft context.', 400);
    const deleted = await FormDraft.destroy({
      where: {
        userId: req.user.id, PatientId: { [Op.in]: family.patientIds }, formKey: req.query.formKey, contextKey,
      },
    });
    return success(res, { deleted });
  } catch (err) {
    console.error('FormDraft.remove error:', err);
    return error(res, 'Failed to discard draft', 500);
  }
};

/** DELETE /api/drafts/:id — discard one of mine (My drafts list). */
const removeById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return error(res, 'Draft not found', 404);
    const deleted = await FormDraft.destroy({ where: { id, userId: req.user.id } });
    if (!deleted) return error(res, 'Draft not found', 404);
    return success(res, { deleted });
  } catch (err) {
    console.error('FormDraft.removeById error:', err);
    return error(res, 'Failed to discard draft', 500);
  }
};

module.exports = { listForPatient, listMine, save, remove, removeById };
