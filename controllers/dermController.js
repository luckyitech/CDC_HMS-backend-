const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const {
  cleanFinding, cleanObservation, splitList, numberLabels, findingStatusAfter, changeMode, diff,
  OBSERVATION_FIELDS, FINDING_FIELDS,
} = require('../utils/dermRules');
const { regionLabel } = require('../utils/dermRegions');
const dermExam = require('../utils/dermExam');
const db = require('../models');

const {
  sequelize, Patient, User, DermFinding, DermFindingRegion, DermObservation, DermEdit, DermPhoto,
  DermProcedure, DermProcedureTarget, HistologyRequest,
} = db;
const { isModuleOn } = require('../services/clinicModules');
const histologyRules = require('../utils/histologyRules');
const { buildSkinVisits } = require('../utils/dermVisits');
const { PERMISSIONS, passesGate } = require('../constants/permissions');

/**
 * Phase 3: per finding, how many (active) procedures name it, and — while the
 * Histology / cytology module is on — its latest histology request that was
 * not cancelled ({ status, specimenNumber, kind, resultSummary, overdue }).
 */
const phase3Summary = async (ids) => {
  const procedureCount = new Map();
  const histology = new Map();
  if (!ids.length) return { procedureCount, histology };
  const targets = await DermProcedureTarget.findAll({
    where: { DermFindingId: { [Op.in]: ids } },
    include: [{ model: DermProcedure, attributes: ['id', 'status'], where: { status: 'active' } }],
    attributes: ['DermFindingId'],
  });
  for (const t of targets) procedureCount.set(t.DermFindingId, (procedureCount.get(t.DermFindingId) || 0) + 1);
  if (await isModuleOn('histology')) {
    const rows = await HistologyRequest.findAll({
      where: { DermFindingId: { [Op.in]: ids }, status: { [Op.ne]: 'cancelled' } },
      order: [['visitDate', 'DESC'], ['id', 'DESC']],
    });
    const today = clinicToday();
    for (const r of rows) {
      if (histology.has(r.DermFindingId)) continue;
      histology.set(r.DermFindingId, {
        id: r.id, status: r.status, specimenNumber: r.specimenNumber, kind: r.kind,
        resultSummary: histologyRules.resultSummary(r), overdue: histologyRules.isOverdue(r, today),
      });
    }
  }
  return { procedureCount, histology };
};

// =====================================================================
// Dermatology — the skin record (Phase 1, 7 Oct 2026).
//
// Routes: routes/derm.js (module switch → 404 while off; reads on
// clinical.view, writes doctor / derm.record). Rules: utils/dermRules.
//
// Merge-aware throughout: a patient's findings are read across the merge
// family; a new finding is written to the canonical patient; any write is
// refused when the file it reaches is a merged-away (deactivated) one.
// Attribution (createdById, doctorId, editedById…) always from the JWT.
// Nothing is hard-deleted: findings and observations are "entered in error"
// with a reason, and every later change is kept in DermEdits.
// =====================================================================

const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr ' : ''}${u.firstName} ${u.lastName}`.trim() : null);
const USER_ATTRS = ['id', 'firstName', 'lastName', 'role'];
const num = (v) => (v === null || v === undefined ? null : Number(v));

// The structured examination (9 Oct 2026): lists as arrays, numbers as numbers.
const MANY_KEYS = new Set([...dermExam.LOOK_FIELDS, ...dermExam.EXAM_FIELDS].filter((f) => f.kind === 'many').map((f) => f.key));
const NUMBER_KEYS = new Set(['sizeMinMm', 'sizeMaxMm', 'bsaPercent', 'lesionCount', 'pullTestCount']);
const readField = (k, v) => {
  if (MANY_KEYS.has(k)) return splitList(v);
  if (NUMBER_KEYS.has(k)) return num(v);
  return v === undefined ? null : v;
};
const examFields = (o) => Object.fromEntries(['sizeMinMm', 'sizeMaxMm', ...dermExam.LOOK_EXAM_KEYS]
  .map((k) => [k, k === 'dermoscopy' ? !!o.dermoscopy : readField(k, o[k])]));

const formatObservation = (o) => ({
  id: o.id,
  findingId: o.DermFindingId,
  visitDate: o.visitDate,
  statusToday: o.statusToday,
  lengthMm: num(o.lengthMm),
  widthMm: num(o.widthMm),
  depthMm: num(o.depthMm),
  measuredBy: o.measuredBy,
  morphology: splitList(o.morphology),
  colours: splitList(o.colours),
  symptoms: splitList(o.symptoms),
  description: o.description,
  diagnosis: o.diagnosis,
  differential: o.differential,
  plan: o.plan,
  planNote: o.planNote,
  reviewIn: o.reviewIn,
  ...examFields(o),
  status: o.status,
  doctorId: o.doctorId,
  doctorName: userName(o.doctor),
  amendedByName: userName(o.amendedBy),
  amendedAt: o.amendedAt,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const formatFinding = (f, label, extra = {}) => ({
  id: f.id,
  label,
  number: f.number,
  type: f.type,
  typeOther: f.typeOther || null,
  title: f.title,
  regions: (f.regions || []).map((r) => r.region),
  regionLabels: (f.regions || []).map((r) => regionLabel(r.region)),
  exactSite: f.exactSite,
  firstNoticed: f.firstNoticed,
  concern: f.concern,
  currentStatus: f.currentStatus,
  diagnosis: f.diagnosis,
  status: f.status,
  createdById: f.createdById,
  createdByName: userName(f.createdBy),
  createdAt: f.createdAt,
  createdDay: f.createdAt ? clinicToday(new Date(f.createdAt)) : null,
  errorReason: f.errorReason,
  errorByName: userName(f.errorBy),
  errorAt: f.errorAt,
  ...extra,
});

/** Labels for every finding in a family (the #001-B rule needs them all). */
const labelsForFamily = async (patientIds, transaction) => {
  const all = await DermFinding.findAll({
    where: { PatientId: { [Op.in]: patientIds } },
    attributes: ['id', 'number', 'createdAt'],
    transaction,
  });
  return numberLabels(all.map((f) => f.get({ plain: true })));
};

/**
 * The family a finding belongs to, for writes: the canonical file it now sits
 * under. Refuses (returns { refuse }) when that file is inactive.
 */
const familyOfFinding = async (finding) => {
  const owner = await Patient.findByPk(finding.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
  if (!owner) return { refuse: [404, 'Patient not found'] };
  let canonical = owner;
  if (owner.mergedIntoId) {
    canonical = await Patient.findByPk(owner.mergedIntoId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
    if (!canonical) return { refuse: [404, 'Patient not found'] };
  }
  const family = await resolvePatient(canonical.uhid);
  if (!family) return { refuse: [404, 'Patient not found'] };
  if (family.isDeactivated) return { refuse: [403, 'This patient file is inactive (merged). Open the active file.'] };
  return { family };
};

const loadFinding = (id, transaction) => DermFinding.findByPk(id, {
  include: [
    { model: DermFindingRegion, as: 'regions' },
    { model: User, as: 'createdBy', attributes: USER_ATTRS },
    { model: User, as: 'errorBy', attributes: USER_ATTRS },
  ],
  transaction,
});

const parseChanges = (text) => { try { return JSON.parse(text); } catch { return {}; } };

// ---------------------------------------------------------------------
// GET /api/derm/patients/:uhid/findings — the case board
// ---------------------------------------------------------------------
// Every finding in the family (entered-in-error ones only with
// ?includeErrors=true), each with its latest observation and the latest one
// before today that has a size (for the "was 5 × 4" line), plus the last
// skin review date. Observations come with the finding detail, not here.
const listFindings = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const where = { PatientId: { [Op.in]: family.patientIds } };
    if (req.query.includeErrors !== 'true') where.status = { [Op.ne]: 'entered_in_error' };

    const findings = await DermFinding.findAll({
      where,
      include: [
        { model: DermFindingRegion, as: 'regions' },
        { model: User, as: 'createdBy', attributes: USER_ATTRS },
        { model: User, as: 'errorBy', attributes: USER_ATTRS },
      ],
      order: [['number', 'ASC'], ['createdAt', 'ASC']],
    });
    const labels = await labelsForFamily(family.patientIds);
    const ids = findings.map((f) => f.id);
    const observations = ids.length ? await DermObservation.findAll({
      where: { DermFindingId: { [Op.in]: ids }, status: 'active' },
      include: [
        { model: User, as: 'doctor', attributes: USER_ATTRS },
        { model: User, as: 'amendedBy', attributes: USER_ATTRS },
      ],
      order: [['visitDate', 'DESC'], ['id', 'DESC']],
    }) : [];

    // How many (active) photos each finding has — the board shows the count;
    // the pictures themselves are only for doctors (dermPhotoController).
    const photoRows = ids.length ? await DermPhoto.findAll({
      where: { DermFindingId: { [Op.in]: ids }, status: 'active' },
      attributes: ['DermFindingId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
      group: ['DermFindingId'],
      raw: true,
    }) : [];
    const photoCount = new Map(photoRows.map((r) => [r.DermFindingId, Number(r.n)]));
    const { procedureCount, histology } = await phase3Summary(ids);

    const today = clinicToday();
    const byFinding = new Map();
    for (const o of observations) {
      if (!byFinding.has(o.DermFindingId)) byFinding.set(o.DermFindingId, []);
      byFinding.get(o.DermFindingId).push(o);
    }

    let lastReview = null;
    const out = findings.map((f) => {
      const obs = byFinding.get(f.id) || [];
      const latest = obs[0] || null;
      const today_ = obs.find((o) => o.visitDate === today) || null;
      const previousSized = obs.find((o) => o.visitDate < today && o.lengthMm !== null) || null;
      for (const o of obs) {
        if (o.visitDate < today && (!lastReview || o.visitDate > lastReview.date)) {
          lastReview = { date: o.visitDate, doctorName: userName(o.doctor) };
        }
      }
      return formatFinding(f, labels.get(f.id), {
        latest: latest ? formatObservation(latest) : null,
        today: today_ ? formatObservation(today_) : null,
        previousSized: previousSized ? formatObservation(previousSized) : null,
        observationCount: obs.length,
        photoCount: photoCount.get(f.id) || 0,
        procedureCount: procedureCount.get(f.id) || 0,
        histology: histology.get(f.id) || null,
      });
    });

    return success(res, { today, findings: out, lastReview, canWrite: !family.isDeactivated });
  } catch (err) {
    console.error('DermFinding.list error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/findings/:id — one finding with its whole timeline
// ---------------------------------------------------------------------
const getFinding = async (req, res) => {
  try {
    const finding = await loadFinding(req.params.id);
    if (!finding) return error(res, 'Finding not found', 404);
    const owner = await Patient.findByPk(finding.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
    const canonicalId = owner?.mergedIntoId || owner?.id;
    const canonical = canonicalId ? await Patient.findByPk(canonicalId, { attributes: ['uhid'] }) : null;
    const family = canonical ? await resolvePatient(canonical.uhid) : null;
    const labels = family ? await labelsForFamily(family.patientIds) : new Map();

    const observations = await DermObservation.findAll({
      where: { DermFindingId: finding.id },
      include: [
        { model: User, as: 'doctor', attributes: USER_ATTRS },
        { model: User, as: 'amendedBy', attributes: USER_ATTRS },
      ],
      order: [['visitDate', 'DESC'], ['id', 'DESC']],
    });
    // Phase 3: procedures that name this finding (with their trail entries).
    const procTargets = await DermProcedureTarget.findAll({ where: { DermFindingId: finding.id }, attributes: ['DermProcedureId'] });
    const procIds = procTargets.map((t) => t.DermProcedureId);
    const edits = await DermEdit.findAll({
      where: {
        [Op.or]: [
          { entity: 'finding', entityId: finding.id },
          { entity: 'observation', entityId: { [Op.in]: observations.map((o) => o.id).concat([0]) } },
          { entity: 'procedure', entityId: { [Op.in]: procIds.concat([0]) } },
        ],
      },
      include: [{ model: User, as: 'editedBy', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
    });

    // Lazily required: the two controllers import each other's helpers.
    const procCtrl = require('./dermProcedureController');
    const procedures = procIds.length ? await DermProcedure.findAll({
      where: { id: { [Op.in]: procIds } }, include: procCtrl.INCLUDE, order: [['procedureDate', 'DESC'], ['id', 'DESC']],
    }) : [];
    const procLabels = family ? await procCtrl.labelsFor(family.patientIds) : new Map();
    let histology = null;   // null = module off (the tab says nothing about histology)
    if (await isModuleOn('histology')) {
      const histCtrl = require('./histologyController');
      const rows = await HistologyRequest.findAll({
        where: { DermFindingId: finding.id }, include: histCtrl.INCLUDE, order: [['visitDate', 'DESC'], ['id', 'DESC']],
      });
      const info = family ? await histCtrl.findingInfo(family.patientIds) : null;
      const today = clinicToday();
      histology = rows.map((r) => histCtrl.formatRequest(r, info, today));
    }

    return success(res, {
      today: clinicToday(),
      uhid: canonical?.uhid || owner?.uhid || null,
      procedures: procedures.map((p) => procCtrl.formatProcedure(p, procLabels)),
      histology,
      finding: formatFinding(finding, labels.get(finding.id) || `#${String(finding.number).padStart(3, '0')}`),
      observations: observations.map(formatObservation),
      edits: edits.map((e) => ({
        id: e.id, entity: e.entity, entityId: e.entityId, action: e.action,
        changes: parseChanges(e.changes), reason: e.reason,
        editedByName: userName(e.editedBy), createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    console.error('DermFinding.get error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/derm/patients/:uhid/findings — a new finding + today's look
// ---------------------------------------------------------------------
// Body: type, title, regions[], exactSite?, firstNoticed?, concern?,
//       observation: { statusToday (default 'new'), sizes, morphology… }
// The number is the next one across the whole family, taken under a lock on
// the canonical patient row so two doctors saving at once can't share it.
const createFinding = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);

    const f = cleanFinding(req.body);
    if (!f.ok) return error(res, f.message, 400, { field: f.field });
    const o = cleanObservation({ statusToday: 'new', ...(req.body.observation || {}) });
    if (!o.ok) return error(res, o.message, 400, { field: o.field });

    const today = clinicToday();
    const id = await sequelize.transaction(async (transaction) => {
      await Patient.findByPk(family.patient.id, { transaction, lock: transaction.LOCK.UPDATE });
      const max = await DermFinding.max('number', {
        where: { PatientId: { [Op.in]: family.patientIds } }, transaction,
      });
      const { regions, ...fields } = f.value;
      const finding = await DermFinding.create({
        ...fields,
        PatientId: family.patient.id,
        number: (Number(max) || 0) + 1,
        currentStatus: o.value.statusToday,
        diagnosis: o.value.diagnosis || null,
        status: findingStatusAfter(o.value.statusToday),
        createdById: req.user.id,
      }, { transaction });
      await DermFindingRegion.bulkCreate(regions.map((region) => ({ DermFindingId: finding.id, region })), { transaction });
      await DermObservation.create({
        ...o.value, DermFindingId: finding.id, visitDate: today, doctorId: req.user.id,
      }, { transaction });
      // Photos taken before the finding existed (8 Oct 2026): the phone's (a
      // capture session) and area photos the doctor chose to file under it.
      const { attachSessionToFinding } = require('./dermCaptureController');   // lazy: avoids a require cycle
      const sessionIds = [].concat(req.body.captureSessionIds || [], req.body.captureSessionId || []).slice(0, 10);
      for (const sessionId of sessionIds) {
        await attachSessionToFinding({ sessionId, userId: req.user.id, finding, patientIds: family.patientIds, transaction });
      }
      const linkIds = Array.isArray(req.body.linkPhotoIds) ? req.body.linkPhotoIds.map(Number).filter(Number.isInteger).slice(0, 100) : [];
      if (linkIds.length) {
        await DermPhoto.update({ DermFindingId: finding.id }, {
          where: { id: { [Op.in]: linkIds }, DermFindingId: null, status: 'active', PatientId: { [Op.in]: family.patientIds } }, transaction,
        });
      }
      return finding.id;
    });

    req.params.id = id;
    return getFinding(req, res);
  } catch (err) {
    console.error('DermFinding.create error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/vocabulary — names the clinic has typed before
// ---------------------------------------------------------------------
// "Other" types already used on any finding (entered-in-error ignored), most
// used first, so the next doctor picks "Keloid" instead of typing it again.
const vocabulary = async (req, res) => {
  try {
    const rows = await DermFinding.findAll({
      attributes: ['typeOther', [sequelize.fn('COUNT', sequelize.col('id')), 'uses']],
      where: { type: 'other', typeOther: { [Op.ne]: null }, status: { [Op.ne]: 'entered_in_error' } },
      group: ['typeOther'],
      order: [[sequelize.literal('uses'), 'DESC'], ['typeOther', 'ASC']],
      limit: 40,
      raw: true,
    });
    // Case-insensitive de-duplication (collations differ between servers).
    const seen = new Set();
    const findingTypes = [];
    for (const r of rows) {
      const name = String(r.typeOther || '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      findingTypes.push({ name, uses: Number(r.uses) || 0 });
    }
    // Words typed under "Other…" in the examination fields (9 Oct 2026), per
    // field, most used first. Read from the most recent entries only — the
    // clinic's habits, not a full history scan.
    const lookCols = Object.keys(dermExam.CHOICE_FIELDS).filter((k) => DermObservation.rawAttributes[k]);
    const examCols = Object.keys(dermExam.CHOICE_FIELDS).filter((k) => db.DermSkinExam.rawAttributes[k]);
    const looks = await DermObservation.findAll({ attributes: lookCols, where: { status: 'active' }, order: [['id', 'DESC']], limit: 3000, raw: true });
    const exams = await db.DermSkinExam.findAll({ attributes: examCols, where: { status: 'active' }, order: [['id', 'DESC']], limit: 1000, raw: true });
    const terms = dermExam.typedTerms([...looks, ...exams]);
    return success(res, { findingTypes, terms });
  } catch (err) {
    console.error('DermFinding.vocabulary error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/derm/findings/:id — change what / where a finding is
// ---------------------------------------------------------------------
// Its creator may correct it on the day it was created without a reason.
// Any other change is an amendment: `reason` required, kept in DermEdits.
const updateFinding = async (req, res) => {
  try {
    const finding = await loadFinding(req.params.id);
    if (!finding) return error(res, 'Finding not found', 404);
    if (finding.status === 'entered_in_error') return error(res, 'This finding was entered in error and can no longer be changed', 409);
    const { refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);

    const f = cleanFinding(req.body, { partial: true });
    if (!f.ok) return error(res, f.message, 400, { field: f.field });
    const { regions, ...fields } = f.value;

    const before = { ...finding.get({ plain: true }), regions: (finding.regions || []).map((r) => r.region).sort().join(',') };
    const after = { ...fields };
    if (regions) after.regions = [...regions].sort().join(',');
    const changes = diff(before, after, [...FINDING_FIELDS, 'regions']);
    if (!Object.keys(changes).length) return error(res, 'Nothing was changed', 400, { code: 'NO_CHANGE' });

    const createdDay = clinicToday(new Date(finding.createdAt));
    const sameDayAuthor = finding.createdById === req.user.id && createdDay === clinicToday();
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!sameDayAuthor && !reason) return error(res, 'Give a reason for changing an earlier entry', 400, { code: 'REASON_REQUIRED' });

    await sequelize.transaction(async (transaction) => {
      if (Object.keys(fields).length) await finding.update(fields, { transaction });
      if (regions) {
        await DermFindingRegion.destroy({ where: { DermFindingId: finding.id }, transaction });
        await DermFindingRegion.bulkCreate(regions.map((region) => ({ DermFindingId: finding.id, region })), { transaction });
      }
      if (!sameDayAuthor) {
        await DermEdit.create({
          entity: 'finding', entityId: finding.id, action: 'amend',
          changes: JSON.stringify(changes), reason: reason.slice(0, 500), editedById: req.user.id,
        }, { transaction });
      }
    });
    return getFinding(req, res);
  } catch (err) {
    console.error('DermFinding.update error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/derm/findings/:id/today — record (or correct) today's look
// ---------------------------------------------------------------------
// One observation per finding per clinic day. None yet → created, author from
// the JWT. Mine from today → changed in place. Someone else's from today →
// 409 SOMEONE_ELSE_TODAY: they amend it instead (with a reason).
const saveToday = async (req, res) => {
  try {
    const finding = await loadFinding(req.params.id);
    if (!finding) return error(res, 'Finding not found', 404);
    if (finding.status === 'entered_in_error') return error(res, 'This finding was entered in error and can no longer be changed', 409);
    const { refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);

    const o = cleanObservation(req.body);
    if (!o.ok) return error(res, o.message, 400, { field: o.field });

    const today = clinicToday();
    await sequelize.transaction(async (transaction) => {
      const existing = await DermObservation.findOne({
        where: { DermFindingId: finding.id, visitDate: today }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (existing && (existing.status !== 'active' || changeMode(existing, req.user.id, today) !== 'edit')) {
        const err = new Error('someone else today'); err.code = 'SOMEONE_ELSE_TODAY'; throw err;
      }
      if (existing) await existing.update(o.value, { transaction });
      else await DermObservation.create({ ...o.value, DermFindingId: finding.id, visitDate: today, doctorId: req.user.id }, { transaction });

      await finding.update({
        currentStatus: o.value.statusToday,
        diagnosis: o.value.diagnosis || finding.diagnosis,
        status: findingStatusAfter(o.value.statusToday),
      }, { transaction });
    });
    return getFinding(req, res);
  } catch (err) {
    if (err.code === 'SOMEONE_ELSE_TODAY') {
      return error(res, 'Another doctor already recorded this finding today. Amend their entry instead (a reason is needed).', 409, { code: 'SOMEONE_ELSE_TODAY' });
    }
    console.error('DermObservation.saveToday error:', err);
    return error(res, 'Server error', 500);
  }
};

/** Re-derive a finding's board fields from its newest active observation. */
const refreshFindingFromLatest = async (finding, transaction) => {
  const latest = await DermObservation.findOne({
    where: { DermFindingId: finding.id, status: 'active' },
    order: [['visitDate', 'DESC'], ['id', 'DESC']], transaction,
  });
  if (!latest) return;
  await finding.update({
    currentStatus: latest.statusToday,
    diagnosis: latest.diagnosis || finding.diagnosis,
    status: findingStatusAfter(latest.statusToday),
  }, { transaction });
};

// ---------------------------------------------------------------------
// PUT /api/derm/observations/:id — amend an earlier look (reason required)
// ---------------------------------------------------------------------
// Only the fields sent are changed; the full before/after of those goes to
// DermEdits. The author stays the author; amendedById / amendedAt record the
// latest amender.
const amendObservation = async (req, res) => {
  try {
    const obs = await DermObservation.findByPk(req.params.id);
    if (!obs) return error(res, 'Entry not found', 404);
    if (obs.status !== 'active') return error(res, 'This entry was marked entered in error and can no longer be changed', 409);
    const finding = await loadFinding(obs.DermFindingId);
    const { refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);

    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Give a reason for amending this entry', 400, { code: 'REASON_REQUIRED' });

    // Validate the merged result, so an amendment can't leave the entry invalid.
    const current = formatObservation(obs);
    const merged = { ...current, ...req.body };
    const o = cleanObservation(merged);
    if (!o.ok) return error(res, o.message, 400, { field: o.field });
    const sent = Object.fromEntries(OBSERVATION_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(req.body, k)).map((k) => [k, o.value[k]]));
    const beforeRaw = obs.get({ plain: true });
    const before = {
      ...beforeRaw, lengthMm: num(beforeRaw.lengthMm), widthMm: num(beforeRaw.widthMm), depthMm: num(beforeRaw.depthMm),
      sizeMinMm: num(beforeRaw.sizeMinMm), sizeMaxMm: num(beforeRaw.sizeMaxMm), bsaPercent: num(beforeRaw.bsaPercent), dermoscopy: !!beforeRaw.dermoscopy,
    };
    const changes = diff(before, sent, OBSERVATION_FIELDS);
    if (!Object.keys(changes).length) return error(res, 'Nothing was changed', 400, { code: 'NO_CHANGE' });

    await sequelize.transaction(async (transaction) => {
      await obs.update({ ...sent, amendedById: req.user.id, amendedAt: new Date() }, { transaction });
      await DermEdit.create({
        entity: 'observation', entityId: obs.id, action: 'amend',
        changes: JSON.stringify(changes), reason: reason.slice(0, 500), editedById: req.user.id,
      }, { transaction });
      await refreshFindingFromLatest(finding, transaction);
    });
    req.params.id = finding.id;
    return getFinding(req, res);
  } catch (err) {
    console.error('DermObservation.amend error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/derm/findings/:id/entered-in-error and
// POST /api/derm/observations/:id/entered-in-error — { reason }
// ---------------------------------------------------------------------
// Hidden from the board, the timeline's active entries and the note; kept in
// the database with who / when / why (D8). Never undone here.
const findingInError = async (req, res) => {
  try {
    const finding = await loadFinding(req.params.id);
    if (!finding) return error(res, 'Finding not found', 404);
    if (finding.status === 'entered_in_error') return error(res, 'Already marked entered in error', 409);
    const { refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Give a reason', 400, { code: 'REASON_REQUIRED' });

    await sequelize.transaction(async (transaction) => {
      const was = finding.status;
      await finding.update({ status: 'entered_in_error', errorReason: reason.slice(0, 500), errorById: req.user.id, errorAt: new Date() }, { transaction });
      await DermEdit.create({
        entity: 'finding', entityId: finding.id, action: 'entered_in_error',
        changes: JSON.stringify({ status: [was, 'entered_in_error'] }), reason: reason.slice(0, 500), editedById: req.user.id,
      }, { transaction });
    });
    return getFinding(req, res);
  } catch (err) {
    console.error('DermFinding.inError error:', err);
    return error(res, 'Server error', 500);
  }
};

const observationInError = async (req, res) => {
  try {
    const obs = await DermObservation.findByPk(req.params.id);
    if (!obs) return error(res, 'Entry not found', 404);
    if (obs.status !== 'active') return error(res, 'Already marked entered in error', 409);
    const finding = await loadFinding(obs.DermFindingId);
    const { refuse } = await familyOfFinding(finding);
    if (refuse) return error(res, refuse[1], refuse[0]);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Give a reason', 400, { code: 'REASON_REQUIRED' });

    await sequelize.transaction(async (transaction) => {
      await obs.update({ status: 'entered_in_error' }, { transaction });
      await DermEdit.create({
        entity: 'observation', entityId: obs.id, action: 'entered_in_error',
        changes: JSON.stringify({ status: ['active', 'entered_in_error'] }), reason: reason.slice(0, 500), editedById: req.user.id,
      }, { transaction });
      await refreshFindingFromLatest(finding, transaction);
    });
    req.params.id = finding.id;
    return getFinding(req, res);
  } catch (err) {
    console.error('DermObservation.inError error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/derm/patients/:uhid/visits — every skin visit (Phase 4, D13)
// ---------------------------------------------------------------------
// For Visit History and the generated note: each clinic day with anything on
// the skin record, read as it was recorded that day (utils/dermVisits), plus
// the "All skin visits" grid. ?date=YYYY-MM-DD returns just that day (the
// note for today). Photos come as metadata only to those who may see them
// (doctor / derm.record — V4); everyone else gets the counts. Pictures are
// never sent here: each one is opened (and logged) on its own.
const skinVisits = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const onlyDate = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;

    const rows = await DermFinding.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, status: { [Op.ne]: 'entered_in_error' } },
      include: [{ model: DermFindingRegion, as: 'regions' }],
      order: [['number', 'ASC'], ['createdAt', 'ASC']],
    });
    const labels = await labelsForFamily(family.patientIds);
    const findings = rows.map((f) => ({
      id: f.id,
      label: labels.get(f.id),
      title: f.title,
      type: f.type,
      regions: (f.regions || []).map((r) => r.region),
      regionLabels: (f.regions || []).map((r) => regionLabel(r.region)),
      exactSite: f.exactSite,
      concern: f.concern,
      status: f.status,
      createdDay: f.createdAt ? clinicToday(new Date(f.createdAt)) : null,
    }));
    const ids = findings.map((f) => f.id);
    const none = [0];

    const observations = await DermObservation.findAll({
      where: { DermFindingId: { [Op.in]: ids.concat(none) }, status: 'active' },
      include: [
        { model: User, as: 'doctor', attributes: USER_ATTRS },
        { model: User, as: 'amendedBy', attributes: USER_ATTRS },
      ],
      order: [['visitDate', 'ASC'], ['id', 'ASC']],
    });
    const edits = await DermEdit.findAll({
      where: { entity: 'observation', action: 'amend', entityId: { [Op.in]: observations.map((o) => o.id).concat(none) } },
      include: [{ model: User, as: 'editedBy', attributes: USER_ATTRS }],
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
    });

    const procCtrl = require('./dermProcedureController');
    const procRows = await DermProcedure.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, status: 'active' },
      include: procCtrl.INCLUDE,
      order: [['procedureDate', 'ASC'], ['id', 'ASC']],
    });
    const procLabels = await procCtrl.labelsFor(family.patientIds);
    const procedures = procRows.map((p) => procCtrl.formatProcedure(p, procLabels));

    const photoRows = await DermPhoto.findAll({
      where: { DermFindingId: { [Op.in]: ids.concat(none) }, status: 'active' },
      attributes: ['id', 'DermFindingId', 'visitDate', 'photoType', 'sensitive', 'marker'],
      order: [['visitDate', 'ASC'], ['id', 'ASC']],
    });

    let histology = [];
    if (await isModuleOn('histology')) {
      const hRows = await HistologyRequest.findAll({
        where: { DermFindingId: { [Op.in]: ids.concat(none) }, status: { [Op.ne]: 'cancelled' } },
        attributes: ['id', 'DermFindingId', 'visitDate', 'specimenNumber', 'kind', 'specimenType', 'status'],
        order: [['visitDate', 'ASC'], ['id', 'ASC']],
      });
      histology = hRows.map((h) => ({
        id: h.id, findingId: h.DermFindingId, visitDate: h.visitDate, specimenNumber: h.specimenNumber,
        kind: h.kind, specimenLabel: histologyRules.LABELS.specimen[h.specimenType] || h.specimenType, status: h.status,
      }));
    }

    // Today's whole-skin exams (9 Oct 2026) — one per clinic day; across a
    // merge family the canonical file's row wins a shared day.
    const skinCtrl = require('./dermSkinExamController');
    const examRows = await db.DermSkinExam.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, status: 'active' },
      include: skinCtrl.INCLUDE, order: [['visitDate', 'ASC'], ['id', 'ASC']],
    });
    const examByDay = new Map();
    for (const e of examRows) {
      if (!examByDay.has(e.visitDate) || e.PatientId === family.patient.id) examByDay.set(e.visitDate, e);
    }
    const skinExams = [...examByDay.values()].map(skinCtrl.formatExam);

    const withPhotos = passesGate(req.user, ['doctor', PERMISSIONS.DERM_RECORD]);
    const built = buildSkinVisits({
      skinExams,
      findings,
      observations: observations.map(formatObservation),
      edits: edits.map((e) => ({
        entityId: e.entityId, action: e.action, changes: parseChanges(e.changes), reason: e.reason,
        editedByName: userName(e.editedBy), createdAt: e.createdAt,
      })),
      procedures,
      photos: photoRows.map((p) => ({
        id: p.id, findingId: p.DermFindingId, visitDate: p.visitDate, photoType: p.photoType, sensitive: !!p.sensitive,
        marker: parseChanges(p.marker || 'null'),
      })),
      histology,
      withPhotos,
    });

    if (onlyDate) {
      return success(res, { today: clinicToday(), date: onlyDate, day: built.days.find((d) => d.date === onlyDate) || null, canViewPhotos: withPhotos });
    }
    return success(res, { today: clinicToday(), days: built.days, grid: built.grid, canViewPhotos: withPhotos });
  } catch (err) {
    console.error('DermFinding.skinVisits error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = {
  skinVisits,
  vocabulary, listFindings, getFinding, createFinding, updateFinding, saveToday, amendObservation,
  findingInError, observationInError,
  // shared with dermPhotoController
  formatObservation, familyOfFinding, loadFinding, userName, USER_ATTRS,
};
