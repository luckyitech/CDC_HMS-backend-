const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const engine = require('../utils/thyroidUsEngine');
const db = require('../models');

const {
  sequelize, ThyroidUltrasound, ThyroidNodule, ThyroidNoduleFollicularAssessment,
  ThyroidUsCatalogItem, ThyroidUltrasoundImage, UltrasoundImage, Patient, User,
} = db;

// ====================================
// HELPERS
// ====================================

// "Dr." only for doctors — a reporting tech signing a report is not titled one.
const clinicianName = (user) => {
  if (!user) return null;
  const prefix = user.role === 'doctor' ? 'Dr. ' : '';
  return `${prefix}${user.firstName || ''} ${user.lastName || ''}`.trim();
};

const reportIncludes = () => ([
  { model: User, as: 'reportedByUser', attributes: ['firstName', 'lastName', 'role'] },
  { model: User, as: 'signedByUser',   attributes: ['firstName', 'lastName', 'role'] },
]);

// Recompute and stamp the engine-derived fields on a nodule payload.
function applyNoduleEngine(n) {
  const t = engine.computeTirads(n);
  const bta = engine.suggestBtaU(n);
  return {
    ...n,
    volume: engine.volume(n.length, n.height, n.width),
    tiradsPoints: t.points,
    tiradsCategory: t.category,
    tiradsInsufficient: t.insufficient,
    tiradsBreakdown: t.breakdown,
    meetsFnaThreshold: t.meetsFnaThreshold,
    meetsFollowUpThreshold: t.meetsFollowUpThreshold,
    btaSuggested: bta.suggested,
    // btaCategory / btaRationale come from the client (clinician confirms).
  };
}

// Load a report and enforce merge-aware access + author/same-day rules.
async function loadReport(id) {
  return ThyroidUltrasound.findOne({ where: { id, status: { [Op.ne]: 'deleted' } } });
}
function isAuthor(report, user) { return report.reportedById && report.reportedById === user.id; }
function reportClinicDay(report) { return clinicToday(new Date(report.createdAt)); }

async function reportNumberFor(year, t) {
  const like = `TUS-${year}-%`;
  const count = await ThyroidUltrasound.count({ where: { reportNumber: { [Op.like]: like } }, transaction: t, paranoid: false });
  return `TUS-${year}-${String(count + 1).padStart(5, '0')}`;
}

// ====================================
// LIST  — GET /?uhid=
// ====================================
exports.list = async (req, res) => {
  try {
    const { uhid } = req.query;
    if (!uhid) return error(res, 'uhid is required', 400);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const reports = await ThyroidUltrasound.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, status: { [Op.ne]: 'deleted' } },
      include: reportIncludes(),
      order: [['createdAt', 'DESC']],
    });
    return success(res, reports);
  } catch (err) {
    console.error('ThyroidUltrasound.list error:', err);
    return error(res, 'Failed to load thyroid ultrasound reports', 500);
  }
};

// ====================================
// CREATE draft — POST /
// ====================================
exports.create = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { uhid, studyType, examDate } = req.body;
    const family = await resolvePatient(uhid);
    if (!family) { await t.rollback(); return error(res, 'Patient not found', 404); }
    if (family.isDeactivated) { await t.rollback(); return error(res, 'This patient record is inactive (merged).', 403); }

    const year = (examDate ? new Date(examDate) : new Date()).getFullYear();
    const reportNumber = await reportNumberFor(year, t);

    const report = await ThyroidUltrasound.create({
      reportNumber,
      PatientId: family.patient.id,
      reportedById: req.user.id,
      studyType: studyType === 'focused' ? 'focused' : 'full',
      examDate: examDate || null,
      status: 'draft',
      tiradsVersion: engine.VERSIONS.tirads,
      btaVersion: engine.VERSIONS.bta,
      follicularVersion: engine.VERSIONS.follicular,
      narrativeVersion: engine.VERSIONS.narrative,
    }, { transaction: t });

    await t.commit();
    return success(res, report, 201);
  } catch (err) {
    await t.rollback();
    console.error('ThyroidUltrasound.create error:', err);
    return error(res, 'Failed to create thyroid ultrasound report', 500);
  }
};

// ====================================
// GET /:id/full  — one request: report + nodules + follicular + images + computed
// ====================================
exports.getFull = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);

    const nodules = await ThyroidNodule.findAll({
      where: { ThyroidUltrasoundId: report.id, status: 'active' },
      include: [{ model: ThyroidNoduleFollicularAssessment }],
      order: [['noduleNumber', 'ASC']],
    });
    const images = await ThyroidUltrasoundImage.findAll({
      where: { ThyroidUltrasoundId: report.id },
      include: [{ model: UltrasoundImage, attributes: ['id', 'fileName', 'fileUrl', 'studyDescription', 'studyDate'] }],
      order: [['orderIndex', 'ASC']],
    });

    // computed (live view) — the stored values are authoritative but we return
    // fresh computes so the client never has to recompute server-authoritative bits.
    const computed = nodules.map((n) => ({
      id: n.id,
      tirads: engine.computeTirads(n.toJSON()),
      btaSuggested: engine.suggestBtaU(n.toJSON()).suggested,
      follicular: n.ThyroidNoduleFollicularAssessment
        ? engine.follicularConcern(n.ThyroidNoduleFollicularAssessment.toJSON(), n.toJSON())
        : null,
      ablation: n.ablationPlanning ? engine.ablationFigures(n.toJSON()) : null,
    }));

    return success(res, {
      report,
      nodules,
      images,
      computed,
      snapshot: report.status === 'signed' ? report.reportSnapshot : null,
      permissions: {
        canEdit: report.status === 'draft' && isAuthor(report, req.user),
        canSign: report.status === 'draft',
        canReopen: report.status === 'signed' && isAuthor(report, req.user) && reportClinicDay(report) === clinicToday(),
      },
      versions: engine.VERSIONS,
    });
  } catch (err) {
    console.error('ThyroidUltrasound.getFull error:', err);
    return error(res, 'Failed to load report', 500);
  }
};

// ====================================
// PATCH /:id  — autosave report-level fields (draft, author)
// ====================================
const REPORT_WRITABLE = new Set([
  'studyType', 'examDate', 'referringClinician', 'indications', 'indicationOther',
  'tsh', 'ft4', 'ft3', 'antiTpo', 'previousCytology', 'previousUltrasound', 'previousAblation', 'currentThyroidMedication',
  'glandSize', 'echotexture', 'echotextureOther', 'echogenicity', 'echogenicityOther', 'pseudonodular',
  'vascularity', 'doppler', 'dopplerOther', 'retrosternalExtension', 'subclavicularExtension',
  'trachealDeviation', 'carotidDisplacement', 'isthmusAppearance', 'otherDiffuseAbnormalities',
  'rightLength', 'rightHeight', 'rightWidth', 'rightVolume', 'rightVolumeSource',
  'leftLength', 'leftHeight', 'leftWidth', 'leftVolume', 'leftVolumeSource', 'isthmusThickness', 'totalVolume',
  'noNodules', 'lymphNodeAssessment', 'lymphNodes', 'technique', 'equipment',
  'conclusion', 'plan', 'planOther',
]);

exports.patch = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'draft') return error(res, 'A signed report cannot be edited. Reopen it (same day) or create a new report.', 403);
    if (!isAuthor(report, req.user)) return error(res, 'Only the report author can edit this draft.', 403);

    const patch = {};
    for (const k of Object.keys(req.body)) if (REPORT_WRITABLE.has(k)) patch[k] = req.body[k];

    // recompute lobe / total volumes when dimensions change
    patch.rightVolume = engine.volume(patch.rightLength ?? report.rightLength, patch.rightHeight ?? report.rightHeight, patch.rightWidth ?? report.rightWidth) ?? report.rightVolume;
    patch.leftVolume = engine.volume(patch.leftLength ?? report.leftLength, patch.leftHeight ?? report.leftHeight, patch.leftWidth ?? report.leftWidth) ?? report.leftVolume;
    const rv = Number(patch.rightVolume) || 0, lv = Number(patch.leftVolume) || 0;
    patch.totalVolume = (rv || lv) ? Math.round((rv + lv) * 100) / 100 : null;

    await report.update(patch);
    return success(res, report);
  } catch (err) {
    console.error('ThyroidUltrasound.patch error:', err);
    return error(res, 'Failed to save report', 500);
  }
};

// ====================================
// NODULE CRUD
// ====================================
exports.addNodule = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'draft' || !isAuthor(report, req.user)) return error(res, 'Only the author can edit this draft.', 403);

    const count = await ThyroidNodule.count({ where: { ThyroidUltrasoundId: report.id, status: 'active' } });
    const payload = applyNoduleEngine({ ...req.body });
    const nodule = await ThyroidNodule.create({
      ...payload,
      ThyroidUltrasoundId: report.id,
      PatientId: report.PatientId,
      noduleNumber: count + 1,
      status: 'active',
    });
    if (report.noNodules) await report.update({ noNodules: false });
    return success(res, nodule, 201);
  } catch (err) {
    console.error('ThyroidUltrasound.addNodule error:', err);
    return error(res, 'Failed to add nodule', 500);
  }
};

exports.updateNodule = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'draft' || !isAuthor(report, req.user)) return error(res, 'Only the author can edit this draft.', 403);

    const nodule = await ThyroidNodule.findOne({ where: { id: req.params.nid, ThyroidUltrasoundId: report.id, status: 'active' } });
    if (!nodule) return error(res, 'Nodule not found', 404);

    const merged = { ...nodule.toJSON(), ...req.body };
    const payload = applyNoduleEngine(merged);
    // only assign known/whitelisted-ish: take payload but keep identity fields
    delete payload.id; delete payload.ThyroidUltrasoundId; delete payload.PatientId; delete payload.status; delete payload.noduleNumber;
    await nodule.update(payload);
    return success(res, nodule);
  } catch (err) {
    console.error('ThyroidUltrasound.updateNodule error:', err);
    return error(res, 'Failed to update nodule', 500);
  }
};

exports.deleteNodule = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'draft' || !isAuthor(report, req.user)) return error(res, 'Only the author can edit this draft.', 403);

    const nodule = await ThyroidNodule.findOne({ where: { id: req.params.nid, ThyroidUltrasoundId: report.id, status: 'active' } });
    if (!nodule) return error(res, 'Nodule not found', 404);
    await nodule.update({ status: 'deleted' });

    // renumber remaining active nodules
    const remaining = await ThyroidNodule.findAll({ where: { ThyroidUltrasoundId: report.id, status: 'active' }, order: [['noduleNumber', 'ASC']] });
    for (let i = 0; i < remaining.length; i++) await remaining[i].update({ noduleNumber: i + 1 });
    return success(res, { deleted: true });
  } catch (err) {
    console.error('ThyroidUltrasound.deleteNodule error:', err);
    return error(res, 'Failed to delete nodule', 500);
  }
};

// ====================================
// FOLLICULAR upsert — PUT /:id/nodules/:nid/follicular
// ====================================
exports.upsertFollicular = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'draft' || !isAuthor(report, req.user)) return error(res, 'Only the author can edit this draft.', 403);

    const nodule = await ThyroidNodule.findOne({ where: { id: req.params.nid, ThyroidUltrasoundId: report.id, status: 'active' } });
    if (!nodule) return error(res, 'Nodule not found', 404);

    const concern = engine.follicularConcern(req.body, nodule.toJSON());
    const data = { ...req.body, sonographicConcern: concern.concern, concernFeatures: concern.features };

    let fa = await ThyroidNoduleFollicularAssessment.findOne({ where: { ThyroidNoduleId: nodule.id } });
    if (fa) await fa.update(data);
    else fa = await ThyroidNoduleFollicularAssessment.create({ ...data, ThyroidNoduleId: nodule.id });
    await nodule.update({ follicularIndicated: 'indicated' });

    return success(res, { follicular: fa, concern });
  } catch (err) {
    console.error('ThyroidUltrasound.upsertFollicular error:', err);
    return error(res, 'Failed to save follicular assessment', 500);
  }
};

// ====================================
// PREVIEW — POST /:id/preview
// ====================================
exports.preview = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);

    const nodules = await ThyroidNodule.findAll({ where: { ThyroidUltrasoundId: report.id, status: 'active' }, order: [['noduleNumber', 'ASC']] });
    const nodulesJson = nodules.map((n) => n.toJSON());
    const { errors, warnings } = engine.validateReport(report.toJSON(), nodulesJson);
    const narrative = engine.generateNarrative(report.toJSON(), nodulesJson);
    const conclusion = (report.conclusion && report.conclusion.length) ? report.conclusion : engine.generateConclusion(report.toJSON(), nodulesJson);

    return success(res, { errors, warnings, narrative, conclusion, computed: nodulesJson.map((n) => engine.computeTirads(n)) });
  } catch (err) {
    console.error('ThyroidUltrasound.preview error:', err);
    return error(res, 'Failed to preview report', 500);
  }
};

// ====================================
// SIGN — POST /:id/sign
// ====================================
exports.sign = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const report = await loadReport(req.params.id);
    if (!report) { await t.rollback(); return error(res, 'Report not found', 404); }
    if (report.status !== 'draft') { await t.rollback(); return error(res, 'Report is already signed.', 409); }

    const nodules = await ThyroidNodule.findAll({ where: { ThyroidUltrasoundId: report.id, status: 'active' }, include: [ThyroidNoduleFollicularAssessment], order: [['noduleNumber', 'ASC']], transaction: t });
    const nodulesJson = nodules.map((n) => n.toJSON());

    const { conclusion, plan, planOther, confirmWarnings, ablationWarningAcknowledged } = req.body;
    if (conclusion) report.conclusion = conclusion;
    if (plan) report.plan = plan;
    if (planOther !== undefined) report.planOther = planOther;

    const { errors, warnings } = engine.validateReport(report.toJSON(), nodulesJson);
    if (errors.length) { await t.rollback(); return error(res, 'Report cannot be signed', 422, { errors, warnings }); }
    if (warnings.length && !confirmWarnings) { await t.rollback(); return error(res, 'Confirm warnings before signing', 422, { errors: [], warnings, needsConfirm: true }); }

    // ablation safety gate
    const gateNeeded = nodulesJson.some((n) => {
      const fa = n.ThyroidNoduleFollicularAssessment;
      return fa && engine.ablationGateRequired(n, { concern: fa.sonographicConcern }, report.plan || []);
    });
    if (gateNeeded && !ablationWarningAcknowledged) {
      await t.rollback();
      return error(res, 'Ablation safety acknowledgement required', 422, { needsAblationAck: true });
    }

    const patient = await Patient.findByPk(report.PatientId, { transaction: t });
    const snapshot = {
      generatedAt: new Date().toISOString(),
      patient: patient ? { uhid: patient.uhid, firstName: patient.firstName, lastName: patient.lastName, dob: patient.dateOfBirth, sex: patient.gender } : null,
      report: report.toJSON(),
      nodules: nodulesJson,
      narrative: engine.generateNarrative(report.toJSON(), nodulesJson),
      conclusion: report.conclusion,
      versions: engine.VERSIONS,
      signatory: { name: clinicianName(req.user), role: req.user.role },
    };

    await report.update({
      status: 'signed',
      findingsNarrative: snapshot.narrative,
      reportSnapshot: snapshot,
      signedAt: new Date(),
      signedById: req.user.id,
      signedName: clinicianName(req.user),
      signedDesignation: req.user.role,
      firstSignedAt: report.firstSignedAt || new Date(),
      ...(gateNeeded ? { ablationWarningAcknowledgedAt: new Date(), ablationWarningAcknowledgedById: req.user.id } : {}),
    }, { transaction: t });

    await t.commit();
    return success(res, report);
  } catch (err) {
    await t.rollback();
    console.error('ThyroidUltrasound.sign error:', err);
    return error(res, 'Failed to sign report', 500);
  }
};

// ====================================
// REOPEN — POST /:id/reopen  (same clinic day, author only)
// ====================================
exports.reopen = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    if (report.status !== 'signed') return error(res, 'Only a signed report can be reopened.', 409);
    if (!isAuthor(report, req.user)) return error(res, 'Only the author can reopen this report.', 403);
    if (clinicToday(new Date(report.signedAt)) !== clinicToday()) return error(res, 'A report can only be reopened on the day it was signed. Create a new report to correct it.', 403);

    await report.update({ status: 'draft', reopenedAt: new Date(), reopenedById: req.user.id });
    return success(res, report);
  } catch (err) {
    console.error('ThyroidUltrasound.reopen error:', err);
    return error(res, 'Failed to reopen report', 500);
  }
};

// ====================================
// DELETE — soft delete (author same-day, or admin)
// ====================================
exports.remove = async (req, res) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return error(res, 'Report not found', 404);
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !(isAuthor(report, req.user) && reportClinicDay(report) === clinicToday()))
      return error(res, 'Only the author (same day) or an admin can delete this report.', 403);

    await report.update({ status: 'deleted', deletedAt: new Date(), deletedBy: req.user.id, deleteReason: req.body.reason || null });
    return success(res, { deleted: true });
  } catch (err) {
    console.error('ThyroidUltrasound.remove error:', err);
    return error(res, 'Failed to delete report', 500);
  }
};

// ====================================
// CATALOG — GET/POST/retire
// ====================================
exports.listCatalog = async (req, res) => {
  try {
    const { type } = req.params;
    if (!['indication', 'plan'].includes(type)) return error(res, 'Invalid catalog type', 400);
    const items = await ThyroidUsCatalogItem.findAll({ where: { type, isActive: true }, order: [['sortOrder', 'ASC'], ['label', 'ASC']] });
    return success(res, items);
  } catch (err) {
    console.error('ThyroidUltrasound.listCatalog error:', err);
    return error(res, 'Failed to load catalog', 500);
  }
};

exports.addCatalog = async (req, res) => {
  try {
    const { type } = req.params;
    if (!['indication', 'plan'].includes(type)) return error(res, 'Invalid catalog type', 400);
    const label = (req.body.label || '').trim();
    if (!label) return error(res, 'Label is required', 400);
    const code = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const [item] = await ThyroidUsCatalogItem.findOrCreate({
      where: { type, code },
      defaults: { type, code, label, addedBy: req.user.id, isActive: true },
    });
    return success(res, item, 201);
  } catch (err) {
    console.error('ThyroidUltrasound.addCatalog error:', err);
    return error(res, 'Failed to add catalog item', 500);
  }
};

exports.retireCatalog = async (req, res) => {
  try {
    const item = await ThyroidUsCatalogItem.findByPk(req.params.id);
    if (!item) return error(res, 'Catalog item not found', 404);
    await item.update({ isActive: false });
    return success(res, item);
  } catch (err) {
    console.error('ThyroidUltrasound.retireCatalog error:', err);
    return error(res, 'Failed to retire catalog item', 500);
  }
};

// ====================================
// IMAGES — PUT /:id/images  (set ordered selection of machine-fed images)
// ====================================
exports.setImages = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const report = await loadReport(req.params.id);
    if (!report) { await t.rollback(); return error(res, 'Report not found', 404); }
    if (report.status !== 'draft' || !isAuthor(report, req.user)) { await t.rollback(); return error(res, 'Only the author can edit this draft.', 403); }

    const family = await resolvePatient((await Patient.findByPk(report.PatientId)).uhid);
    const items = Array.isArray(req.body.images) ? req.body.images : [];

    // validate every image belongs to this patient family (merge-aware)
    const ids = items.map((i) => i.UltrasoundImageId);
    if (ids.length) {
      const owned = await UltrasoundImage.count({ where: { id: { [Op.in]: ids }, PatientId: { [Op.in]: family.patientIds } } });
      if (owned !== ids.length) { await t.rollback(); return error(res, 'One or more images do not belong to this patient.', 422); }
    }

    await ThyroidUltrasoundImage.destroy({ where: { ThyroidUltrasoundId: report.id }, transaction: t });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await ThyroidUltrasoundImage.create({
        ThyroidUltrasoundId: report.id,
        ThyroidNoduleId: it.ThyroidNoduleId || null,
        UltrasoundImageId: it.UltrasoundImageId,
        imageType: it.imageType || null,
        caption: it.caption || null,
        orderIndex: i,
        brightness: it.brightness ?? 1,
        scale: it.scale ?? 1,
        offsetX: it.offsetX ?? 0,
        offsetY: it.offsetY ?? 0,
      }, { transaction: t });
    }
    await t.commit();
    const images = await ThyroidUltrasoundImage.findAll({ where: { ThyroidUltrasoundId: report.id }, order: [['orderIndex', 'ASC']] });
    return success(res, images);
  } catch (err) {
    await t.rollback();
    console.error('ThyroidUltrasound.setImages error:', err);
    return error(res, 'Failed to set report images', 500);
  }
};
