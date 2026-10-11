const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const { numberLabels, diff } = require('../utils/dermRules');
const P = require('../utils/dermProcedures');
const { recordSettingChanges } = require('../services/settingChangeLog');
const db = require('../models');

const {
  sequelize, Patient, User, Setting, DermFinding, DermProcedure, DermProcedureTarget, DermEdit, HistologyRequest,
} = db;

// =====================================================================
// Dermatology procedures (Phase 3, 7 Oct 2026; decision H8) — recorded on
// one or more findings, not billed. Rules: utils/dermProcedures.
// Routes: routes/derm.js (module switch; reads clinical.view; writes doctor /
// derm.record; the clinic's procedure LIST is admin / config.write).
// Merge-aware: read across the family, write to the canonical patient.
// Attribution from the JWT. Never deleted — entered in error; amendments
// after the day are kept in DermEdits (entity 'procedure').
// =====================================================================

const USER_ATTRS = ['id', 'firstName', 'lastName', 'role'];
const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr ' : ''}${u.firstName} ${u.lastName}`.trim() : null);

const readList = async () => {
  const row = await Setting.findOne({ where: { key: P.SETTING_KEY } });
  return P.parseProcedureList(row?.value);
};

const INCLUDE = [
  { model: DermProcedureTarget, as: 'targets', attributes: ['DermFindingId'] },
  { model: User, as: 'performedBy', attributes: USER_ATTRS },
  { model: User, as: 'errorBy', attributes: USER_ATTRS },
  { model: User, as: 'amendedBy', attributes: USER_ATTRS },
  { model: HistologyRequest, as: 'histologyRequest', attributes: ['id', 'specimenNumber', 'kind', 'status'] },
];

const labelsFor = async (patientIds) => {
  const all = await DermFinding.findAll({
    where: { PatientId: { [Op.in]: patientIds } },
    attributes: ['id', 'number', 'createdAt', 'title'],
  });
  const labels = numberLabels(all.map((f) => ({ id: f.id, number: f.number, createdAt: f.createdAt })));
  return new Map(all.map((f) => [f.id, { label: labels.get(f.id), title: f.title }]));
};

const formatProcedure = (p, labels) => {
  const ids = (p.targets || []).map((t) => t.DermFindingId).sort((a, b) => a - b);
  return {
    id: p.id,
    procedureDate: p.procedureDate,
    name: p.name,
    details: p.details,
    findingIds: ids,
    findings: ids.map((id) => ({ id, label: labels.get(id)?.label || '#?', title: labels.get(id)?.title || '' })),
    performedById: p.performedById,
    performedByName: userName(p.performedBy),
    histology: p.histologyRequest ? {
      id: p.histologyRequest.id, specimenNumber: p.histologyRequest.specimenNumber,
      kind: p.histologyRequest.kind, status: p.histologyRequest.status,
    } : null,
    status: p.status,
    errorReason: p.errorReason,
    errorByName: userName(p.errorBy),
    errorAt: p.errorAt,
    amendedByName: userName(p.amendedBy),
    amendedAt: p.amendedAt,
    createdAt: p.createdAt,
  };
};

/** The family a procedure belongs to (for writes); refuses a merged-away file. */
const familyOfProcedure = async (p) => {
  const owner = await Patient.findByPk(p.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
  if (!owner) return { refuse: [404, 'Patient not found'] };
  const canonical = owner.mergedIntoId ? await Patient.findByPk(owner.mergedIntoId, { attributes: ['id', 'uhid'] }) : owner;
  if (!canonical) return { refuse: [404, 'Patient not found'] };
  const family = await resolvePatient(canonical.uhid);
  if (!family) return { refuse: [404, 'Patient not found'] };
  if (family.isDeactivated) return { refuse: [403, 'This patient file is inactive (merged). Open the active file.'] };
  return { family };
};

/** Every id must be a live finding of this family. */
const checkFindings = async (ids, patientIds) => {
  const n = await DermFinding.count({
    where: { id: { [Op.in]: ids }, PatientId: { [Op.in]: patientIds }, status: { [Op.ne]: 'entered_in_error' } },
  });
  return n === ids.length;
};

const respondOne = async (res, id, patientIds, status = 200) => {
  const p = await DermProcedure.findByPk(id, { include: INCLUDE });
  return success(res, formatProcedure(p, await labelsFor(patientIds)), status);
};

// GET /api/derm/procedure-list — the clinic's list (anyone who reads the record)
const getList = async (req, res) => {
  try {
    const row = await Setting.findOne({ where: { key: P.SETTING_KEY } });
    return success(res, { procedures: P.parseProcedureList(row?.value), isDefault: !row, defaults: P.DEFAULT_PROCEDURES });
  } catch (err) {
    console.error('DermProcedure.getList error:', err);
    return error(res, 'Server error', 500);
  }
};

// PUT /api/derm/procedure-list — { procedures: [names] } (admin / config.write; logged)
const putList = async (req, res) => {
  try {
    const clean = P.cleanProcedureList(req.body.procedures);
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });
    const before = await readList();
    const [row] = await Setting.findOrCreate({ where: { key: P.SETTING_KEY }, defaults: { value: JSON.stringify(before) } });
    await row.update({ value: JSON.stringify(clean.value) });
    recordSettingChanges({
      user: req.user, area: 'Specialist modules',
      before: { procedures: before.join(', ') }, after: { procedures: clean.value.join(', ') },
      fields: { procedures: { key: P.SETTING_KEY, label: 'Dermatology procedure list' } },
    });
    return success(res, { procedures: clean.value, isDefault: false, defaults: P.DEFAULT_PROCEDURES });
  } catch (err) {
    console.error('DermProcedure.putList error:', err);
    return error(res, 'Server error', 500);
  }
};

// GET /api/derm/patients/:uhid/procedures (?findingId, ?includeErrors)
const listForPatient = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const where = { PatientId: { [Op.in]: family.patientIds } };
    if (req.query.includeErrors !== 'true') where.status = 'active';
    const include = INCLUDE.map((i) => ({ ...i }));
    let rows = await DermProcedure.findAll({ where, include, order: [['procedureDate', 'DESC'], ['id', 'DESC']] });
    if (req.query.findingId) {
      const fid = Number(req.query.findingId);
      rows = rows.filter((p) => (p.targets || []).some((t) => t.DermFindingId === fid));
    }
    const labels = await labelsFor(family.patientIds);
    return success(res, rows.map((p) => formatProcedure(p, labels)));
  } catch (err) {
    console.error('DermProcedure.listForPatient error:', err);
    return error(res, 'Server error', 500);
  }
};

// POST /api/derm/patients/:uhid/procedures — { name, details, findingIds }
const create = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);
    const clean = P.cleanProcedure(req.body, await readList());
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });
    const v = clean.value;
    if (!await checkFindings(v.findingIds, family.patientIds)) {
      return error(res, 'Choose findings on this patient\'s skin record', 400, { field: 'findingIds' });
    }
    const id = await sequelize.transaction(async (t) => {
      const p = await DermProcedure.create({
        PatientId: family.patient.id,
        procedureDate: clinicToday(),
        name: v.name,
        details: v.details,
        performedById: req.user.id,
        status: 'active',
      }, { transaction: t });
      await DermProcedureTarget.bulkCreate(v.findingIds.map((fid) => ({ DermProcedureId: p.id, DermFindingId: fid })), { transaction: t });
      return p.id;
    });
    return respondOne(res, id, family.patientIds, 201);
  } catch (err) {
    console.error('DermProcedure.create error:', err);
    return error(res, 'Server error', 500);
  }
};

// PUT /api/derm/procedures/:id — edit (author, same day) or amend (reason)
const update = async (req, res) => {
  try {
    const p = await DermProcedure.findByPk(req.params.id, { include: INCLUDE });
    if (!p) return error(res, 'Procedure not found', 404);
    if (p.status !== 'active') return error(res, 'This procedure was marked entered in error.', 409, { code: 'IN_ERROR' });
    const { family, refuse } = await familyOfProcedure(p);
    if (refuse) return error(res, refuse[1], refuse[0]);

    const clean = P.cleanProcedure(req.body, await readList(), { partial: true, currentName: p.name });
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });
    const v = clean.value;
    if (v.findingIds && !await checkFindings(v.findingIds, family.patientIds)) {
      return error(res, 'Choose findings on this patient\'s skin record', 400, { field: 'findingIds' });
    }
    const before = {
      name: p.name, details: p.details,
      findingIds: (p.targets || []).map((t) => t.DermFindingId).sort((a, b) => a - b).join(','),
    };
    const after = { ...v };
    if (after.findingIds) after.findingIds = after.findingIds.join(',');
    const changes = diff(before, after, P.PROCEDURE_FIELDS);
    if (!Object.keys(changes).length) return respondOne(res, p.id, family.patientIds);

    const mode = P.procedureChangeMode(p, req.user.id, clinicToday());
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (mode === 'amend' && !reason) {
      return error(res, 'Say why this procedure is being amended (the original is kept)', 400, { field: 'reason', code: 'REASON_REQUIRED' });
    }
    if (reason.length > 500) return error(res, 'Reason is too long (500 characters)', 400, { field: 'reason' });

    await sequelize.transaction(async (t) => {
      const fields = {};
      if (v.name !== undefined) fields.name = v.name;
      if (v.details !== undefined) fields.details = v.details;
      if (mode === 'amend') { fields.amendedById = req.user.id; fields.amendedAt = new Date(); }
      await p.update(fields, { transaction: t });
      if (v.findingIds) {
        await DermProcedureTarget.destroy({ where: { DermProcedureId: p.id }, transaction: t });
        await DermProcedureTarget.bulkCreate(v.findingIds.map((fid) => ({ DermProcedureId: p.id, DermFindingId: fid })), { transaction: t });
      }
      if (mode === 'amend') {
        await DermEdit.create({
          entity: 'procedure', entityId: p.id, action: 'amend', changes: JSON.stringify(changes), reason, editedById: req.user.id,
        }, { transaction: t });
      }
    });
    return respondOne(res, p.id, family.patientIds);
  } catch (err) {
    console.error('DermProcedure.update error:', err);
    return error(res, 'Server error', 500);
  }
};

// POST /api/derm/procedures/:id/entered-in-error — { reason }
const enteredInError = async (req, res) => {
  try {
    const p = await DermProcedure.findByPk(req.params.id);
    if (!p) return error(res, 'Procedure not found', 404);
    if (p.status !== 'active') return error(res, 'Already marked entered in error.', 409, { code: 'IN_ERROR' });
    const { family, refuse } = await familyOfProcedure(p);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Say why this procedure is being marked entered in error', 400, { field: 'reason' });
    if (reason.length > 500) return error(res, 'Reason is too long (500 characters)', 400, { field: 'reason' });
    await sequelize.transaction(async (t) => {
      await p.update({ status: 'entered_in_error', errorReason: reason, errorById: req.user.id, errorAt: new Date() }, { transaction: t });
      await DermEdit.create({
        entity: 'procedure', entityId: p.id, action: 'entered_in_error',
        changes: JSON.stringify({ status: ['active', 'entered_in_error'] }), reason, editedById: req.user.id,
      }, { transaction: t });
    });
    return respondOne(res, p.id, family.patientIds);
  } catch (err) {
    console.error('DermProcedure.enteredInError error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = { getList, putList, listForPatient, create, update, enteredInError, formatProcedure, labelsFor, INCLUDE };
