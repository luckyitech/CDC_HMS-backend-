const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday, clinicClockTime } = require('../utils/clinicTime');
const { generateNumber, generateLabTestNumber, generateRequisitionNumber } = require('../utils/generateId');
const R = require('../utils/histologyRules');
const { numberLabels, diff } = require('../utils/dermRules');
const { regionLabel } = require('../utils/dermRegions');
const { BIOPSY_PROCEDURE } = require('../utils/dermProcedures');
const { isModuleOn } = require('../services/clinicModules');
const { PERMISSIONS, passesGate } = require('../constants/permissions');
const db = require('../models');

const {
  sequelize, Patient, User, LabTest, CatalogItem, MedicalDocument, HistologyRequest, HistologyEdit,
  DermFinding, DermFindingRegion, DermProcedure, DermProcedureTarget,
} = db;

// =====================================================================
// Histology / cytology (Dermatology Phase 3, 7 Oct 2026; D11, H1–H12).
//
// Routes: routes/histology.js (module switch 'histology' → 404 while off;
// reads on clinical.view, writes doctor / histology.record).
//
// A request raises ONE Pending lab request ("Histopathology" / "Cytology") on
// its own requisition, priced from the lab catalogue when the clinic lists it
// there — the lab and billing see it like any other (H3). The doctor types
// the result when the report is back (H4); the report PDF is an ordinary
// Medical Document of this patient. A skin specimen may name a finding, but
// only while Dermatology is on.
//
// Merge-aware: read across the family, write to the canonical patient, refuse
// writes on a merged-away file. Attribution always from the JWT. Nothing is
// deleted — cancel with a reason; a result corrected after its day keeps the
// original in HistologyEdits (H5).
// =====================================================================

const USER_ATTRS = ['id', 'firstName', 'lastName', 'role'];
const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr ' : ''}${u.firstName} ${u.lastName}`.trim() : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const parseChanges = (t) => { try { return JSON.parse(t); } catch { return {}; } };

const INCLUDE = [
  { model: User, as: 'requestedBy', attributes: USER_ATTRS },
  { model: User, as: 'resultBy', attributes: USER_ATTRS },
  { model: User, as: 'cancelledBy', attributes: USER_ATTRS },
  { model: LabTest, as: 'labTest', attributes: ['id', 'testNumber', 'requisitionNumber', 'status'] },
  { model: MedicalDocument, as: 'reportDocument', attributes: ['id', 'documentId', 'fileName', 'fileUrl', 'documentCategory', 'testDate', 'isArchived'] },
];

/** Finding id → { label, title, regions } for the family (only when Dermatology is on). */
const findingInfo = async (patientIds) => {
  if (!await isModuleOn('dermatology')) return null;
  const all = await DermFinding.findAll({
    where: { PatientId: { [Op.in]: patientIds } },
    attributes: ['id', 'number', 'createdAt', 'title', 'status'],
    include: [{ model: DermFindingRegion, as: 'regions', attributes: ['region'] }],
  });
  const labels = numberLabels(all.map((f) => ({ id: f.id, number: f.number, createdAt: f.createdAt })));
  return new Map(all.map((f) => [f.id, {
    label: labels.get(f.id),
    title: f.title,
    status: f.status,
    where: (f.regions || []).map((r) => regionLabel(r.region)).join(', '),
  }]));
};

const formatRequest = (r, findings, today) => {
  const f = r.DermFindingId && findings ? findings.get(r.DermFindingId) : null;
  const findingLabel = f ? `${f.label} ${f.title}` : null;
  const plain = {
    status: r.status, kind: r.kind, siteType: r.siteType, thyroidLobe: r.thyroidLobe, noduleLabel: r.noduleLabel,
    tirads: r.tirads, siteText: r.siteText, resultDiagnosis: r.resultDiagnosis, margins: r.margins,
    marginMm: num(r.marginMm), bethesda: r.bethesda, cytologyCategory: r.cytologyCategory,
  };
  const doc = r.reportDocument;
  return {
    id: r.id,
    specimenNumber: r.specimenNumber,
    kind: r.kind,
    siteType: r.siteType,
    // A finding is named only while Dermatology is on; the id stays on record.
    findingId: f ? r.DermFindingId : null,
    findingLabel,
    findingWhere: f ? f.where : null,
    thyroidLobe: r.thyroidLobe,
    noduleLabel: r.noduleLabel,
    tirads: r.tirads,
    siteText: r.siteText,
    site: R.siteSummary(plain, findingLabel),
    specimenType: r.specimenType,
    specimenLabel: R.LABELS.specimen[r.specimenType] || r.specimenType,
    pieces: r.pieces,
    fixative: r.fixative,
    clinicalDetails: r.clinicalDetails,
    sendTo: r.sendTo,
    visitDate: r.visitDate,
    requestedById: r.requestedById,
    requestedByName: userName(r.requestedBy),
    labTest: r.labTest ? {
      id: r.labTest.id, testNumber: r.labTest.testNumber,
      requisitionNumber: r.labTest.requisitionNumber, status: r.labTest.status,
    } : null,
    status: r.status,
    overdue: R.isOverdue(r, today),
    daysWaiting: r.status === 'awaiting' ? R.daysBetween(r.visitDate, today) : null,
    resultShape: R.resultShape(r),
    resultDiagnosis: r.resultDiagnosis,
    margins: r.margins,
    marginMm: num(r.marginMm),
    bethesda: r.bethesda,
    cytologyCategory: r.cytologyCategory,
    resultComment: r.resultComment,
    resultSummary: R.resultSummary(plain),
    reportDate: r.reportDate,
    reportDocument: doc ? {
      id: doc.id, documentId: doc.documentId, fileName: doc.fileName, fileUrl: doc.fileUrl,
      category: doc.documentCategory, testDate: doc.testDate, archived: !!doc.isArchived,
    } : null,
    resultById: r.resultById,
    resultByName: userName(r.resultBy),
    resultAt: r.resultAt,
    resultDay: r.resultAt ? clinicToday(new Date(r.resultAt)) : null,
    cancelReason: r.cancelReason,
    cancelledByName: userName(r.cancelledBy),
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
  };
};

/** The canonical family a request now belongs to, for writes. */
const familyOfRequest = async (request) => {
  const owner = await Patient.findByPk(request.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
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

const loadRequest = (id, transaction) => HistologyRequest.findByPk(id, { include: INCLUDE, transaction });

const respondOne = async (res, id, status = 200) => {
  const r = await loadRequest(id);
  const owner = await Patient.findByPk(r.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
  const canonicalId = owner.mergedIntoId || owner.id;
  const canonical = await Patient.findByPk(canonicalId, { attributes: ['uhid'] });
  const family = await resolvePatient(canonical.uhid);
  const findings = await findingInfo(family.patientIds);
  return success(res, formatRequest(r, findings, clinicToday()), status);
};

// ---------------------------------------------------------------------
// GET /api/histology/patients/:uhid — every request for the family
// ---------------------------------------------------------------------
const listForPatient = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const where = { PatientId: { [Op.in]: family.patientIds } };
    if (req.query.findingId) where.DermFindingId = Number(req.query.findingId) || 0;
    const rows = await HistologyRequest.findAll({
      where, include: INCLUDE, order: [['visitDate', 'DESC'], ['id', 'DESC']],
    });
    const findings = await findingInfo(family.patientIds);
    const today = clinicToday();
    const requests = rows.map((r) => formatRequest(r, findings, today));
    return success(res, {
      requests,
      counts: {
        awaiting: requests.filter((r) => r.status === 'awaiting').length,
        overdue: requests.filter((r) => r.overdue).length,
      },
      overdueDays: R.OVERDUE_DAYS,
      dermatologyOn: findings !== null,
    });
  } catch (err) {
    console.error('HistologyRequest.listForPatient error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/histology/:id — one request with its trail
// ---------------------------------------------------------------------
const getOne = async (req, res) => {
  try {
    const r = await loadRequest(req.params.id);
    if (!r) return error(res, 'Request not found', 404);
    const owner = await Patient.findByPk(r.PatientId, { attributes: ['id', 'uhid', 'mergedIntoId'] });
    const canonical = owner.mergedIntoId ? await Patient.findByPk(owner.mergedIntoId, { attributes: ['uhid'] }) : owner;
    req.params.uhid = canonical.uhid;   // for the access log
    const family = await resolvePatient(canonical.uhid);
    const findings = await findingInfo(family.patientIds);
    const edits = await HistologyEdit.findAll({
      where: { HistologyRequestId: r.id },
      include: [{ model: User, as: 'editedBy', attributes: USER_ATTRS }],
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
    });
    return success(res, {
      ...formatRequest(r, findings, clinicToday()),
      trail: edits.map((e) => ({
        id: e.id, action: e.action, changes: parseChanges(e.changes), reason: e.reason,
        editedByName: userName(e.editedBy), createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    console.error('HistologyRequest.getOne error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/histology/patients/:uhid — a new request (+ its lab request,
// + optionally the biopsy as a procedure on the finding, H9)
// ---------------------------------------------------------------------
const create = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient file is inactive (merged). Open the active file.', 403);

    const clean = R.cleanRequest(req.body);
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });
    const v = clean.value;

    // A skin specimen names a finding of THIS family, and only while
    // Dermatology is on (a finding is a Dermatology object).
    let finding = null;
    if (v.siteType === 'skin') {
      if (!await isModuleOn('dermatology')) {
        return error(res, 'Skin findings need the Dermatology module. Choose "Other site" and describe it.', 400, { field: 'siteType' });
      }
      finding = await DermFinding.findOne({
        where: { id: v.findingId, PatientId: { [Op.in]: family.patientIds }, status: { [Op.ne]: 'entered_in_error' } },
      });
      if (!finding) return error(res, 'That skin finding is not on this patient\'s record', 400, { field: 'findingId' });
    }

    // H9: record the biopsy as a procedure too — only for a skin biopsy type,
    // and only for someone who may record skin procedures.
    const biopsyName = BIOPSY_PROCEDURE[v.specimenType];
    const recordProcedure = v.alsoRecordProcedure && finding && !!biopsyName
      && passesGate(req.user, ['doctor', PERMISSIONS.DERM_RECORD]);

    const today = clinicToday();
    const now = new Date();
    const catalogue = await CatalogItem.findOne({ where: { type: 'labTest', name: R.LAB_TEST_NAME[v.kind] } });

    const created = await sequelize.transaction(async (t) => {
      const specimenNumber = await generateNumber(HistologyRequest, 'specimenNumber', R.NUMBER_PREFIX[v.kind]);
      const testNumber = await generateLabTestNumber(LabTest);
      const requisitionNumber = await generateRequisitionNumber(LabTest);
      const site = R.siteSummary(v, finding ? `#${String(finding.number).padStart(3, '0')} ${finding.title}` : null);
      const lab = await LabTest.create({
        testNumber,
        requisitionNumber,
        PatientId: family.patient.id,
        testType: R.LAB_TEST_NAME[v.kind],
        sampleType: R.LABELS.specimen[v.specimenType],
        priority: 'Routine',
        orderedById: req.user.id,
        price: catalogue && catalogue.price != null ? catalogue.price : null,
        orderedDate: today,
        orderedTime: clinicClockTime({}, now),
        status: 'Pending',
        notes: [`Specimen ${specimenNumber}`, site, v.sendTo ? `Send to: ${v.sendTo}` : null, v.clinicalDetails]
          .filter(Boolean).join('\n').slice(0, 6000),
      }, { transaction: t });

      const row = await HistologyRequest.create({
        PatientId: family.patient.id,
        specimenNumber,
        kind: v.kind,
        siteType: v.siteType,
        DermFindingId: finding ? finding.id : null,
        thyroidLobe: v.thyroidLobe,
        noduleLabel: v.noduleLabel,
        tirads: v.tirads,
        siteText: v.siteText,
        specimenType: v.specimenType,
        pieces: v.pieces,
        fixative: v.fixative,
        clinicalDetails: v.clinicalDetails,
        sendTo: v.sendTo,
        visitDate: today,
        LabTestId: lab.id,
        requestedById: req.user.id,
        status: 'awaiting',
      }, { transaction: t });

      let procedureId = null;
      if (recordProcedure) {
        const detail = [
          v.pieces ? `${v.pieces} piece${v.pieces === 1 ? '' : 's'}` : null,
          v.fixative ? `in ${v.fixative}` : null,
          `sent for ${v.kind} (${specimenNumber})`,
        ].filter(Boolean).join(', ');
        const p = await DermProcedure.create({
          PatientId: family.patient.id,
          procedureDate: today,
          name: biopsyName,
          details: detail,
          performedById: req.user.id,
          HistologyRequestId: row.id,
          status: 'active',
        }, { transaction: t });
        await DermProcedureTarget.create({ DermProcedureId: p.id, DermFindingId: finding.id }, { transaction: t });
        procedureId = p.id;
      }
      return { id: row.id, procedureId };
    });

    const r = await loadRequest(created.id);
    const findings = await findingInfo(family.patientIds);
    return success(res, { ...formatRequest(r, findings, today), procedureId: created.procedureId }, 201);
  } catch (err) {
    console.error('HistologyRequest.create error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// PUT /api/histology/:id/result — record, or correct, the typed result
// ---------------------------------------------------------------------
// First result: anyone who may record. A correction: the person who typed it,
// the same clinic day, in place; otherwise a reason, kept with before/after.
const saveResult = async (req, res) => {
  try {
    const r = await HistologyRequest.findByPk(req.params.id);
    if (!r) return error(res, 'Request not found', 404);
    const { family, refuse } = await familyOfRequest(r);
    if (refuse) return error(res, refuse[1], refuse[0]);
    if (r.status === 'cancelled') return error(res, 'This request was cancelled; it cannot take a result.', 409, { code: 'CANCELLED' });

    const clean = R.cleanResult(r, req.body);
    if (!clean.ok) return error(res, clean.message, 400, { field: clean.field });
    const v = clean.value;

    if (v.reportDocumentId) {
      const doc = await MedicalDocument.findOne({
        where: { id: v.reportDocumentId, PatientId: { [Op.in]: family.patientIds } },
      });
      if (!doc) return error(res, 'That report is not one of this patient\'s documents', 400, { field: 'reportDocumentId' });
    }

    const today = clinicToday();
    if (r.status === 'resulted') {
      const before = {};
      for (const f of R.RESULT_FIELDS) before[f] = f === 'marginMm' ? num(r[f]) : r[f];
      const changes = diff(before, v, R.RESULT_FIELDS);
      if (!Object.keys(changes).length) return respondOne(res, r.id);
      const mode = R.resultChangeMode({
        resultById: r.resultById, resultAt: r.resultAt,
        resultDay: r.resultAt ? clinicToday(new Date(r.resultAt)) : null,
      }, req.user.id, today);
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      if (mode === 'amend' && !reason) {
        return error(res, 'Say why the result is being corrected (the original is kept)', 400, { field: 'reason', code: 'REASON_REQUIRED' });
      }
      if (reason.length > 500) return error(res, 'Reason is too long (500 characters)', 400, { field: 'reason' });
      await sequelize.transaction(async (t) => {
        await r.update(v, { transaction: t });
        if (mode === 'amend') {
          await HistologyEdit.create({
            HistologyRequestId: r.id, action: 'amend_result', changes: JSON.stringify(changes),
            reason, editedById: req.user.id,
          }, { transaction: t });
        }
      });
      return respondOne(res, r.id);
    }

    // First result: completes the lab row (unless the lab already closed it).
    await sequelize.transaction(async (t) => {
      await r.update({ ...v, status: 'resulted', resultById: req.user.id, resultAt: new Date() }, { transaction: t });
      if (r.LabTestId) {
        const lab = await LabTest.findByPk(r.LabTestId, { transaction: t });
        if (lab && !['Completed', 'Cancelled'].includes(lab.status)) {
          const who = await User.findByPk(req.user.id, { attributes: USER_ATTRS, transaction: t });
          await lab.update({
            status: 'Completed',
            completedBy: userName(who),
            completedDate: new Date(),
            results: { histologyRequestId: r.id, specimenNumber: r.specimenNumber, summary: R.resultSummary({ ...r.get({ plain: true }), ...v, status: 'resulted' }) },
          }, { transaction: t });
        }
      }
    });
    return respondOne(res, r.id);
  } catch (err) {
    console.error('HistologyRequest.saveResult error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// POST /api/histology/:id/cancel — cancel a request still awaiting its result
// ---------------------------------------------------------------------
const cancel = async (req, res) => {
  try {
    const r = await HistologyRequest.findByPk(req.params.id);
    if (!r) return error(res, 'Request not found', 404);
    const { refuse } = await familyOfRequest(r);
    if (refuse) return error(res, refuse[1], refuse[0]);
    if (r.status !== 'awaiting') {
      return error(res, r.status === 'resulted'
        ? 'A result is already recorded. Correct the result instead.'
        : 'Already cancelled.', 409, { code: 'NOT_AWAITING' });
    }
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return error(res, 'Say why the request is being cancelled', 400, { field: 'reason' });
    if (reason.length > 500) return error(res, 'Reason is too long (500 characters)', 400, { field: 'reason' });

    await sequelize.transaction(async (t) => {
      await r.update({ status: 'cancelled', cancelReason: reason, cancelledById: req.user.id, cancelledAt: new Date() }, { transaction: t });
      await HistologyEdit.create({
        HistologyRequestId: r.id, action: 'cancel', changes: JSON.stringify({ status: ['awaiting', 'cancelled'] }),
        reason, editedById: req.user.id,
      }, { transaction: t });
      if (r.LabTestId) {
        const lab = await LabTest.findByPk(r.LabTestId, { transaction: t });
        if (lab && ['Pending', 'Sample Collected'].includes(lab.status)) {
          const who = await User.findByPk(req.user.id, { attributes: USER_ATTRS, transaction: t });
          await lab.update({
            status: 'Cancelled', cancelledBy: userName(who), cancelledByRole: who?.role || null, cancelledAt: new Date(),
          }, { transaction: t });
        }
      }
    });
    return respondOne(res, r.id);
  } catch (err) {
    console.error('HistologyRequest.cancel error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/histology/patients/:uhid/documents — the patient's documents a
// report can be chosen from (PDFs and images, newest first, not archived)
// ---------------------------------------------------------------------
const reportCandidates = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found', 404);
    const docs = await MedicalDocument.findAll({
      where: { PatientId: { [Op.in]: family.patientIds }, isArchived: false },
      attributes: ['id', 'documentId', 'fileName', 'fileUrl', 'documentCategory', 'testDate', 'labName', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 60,
    });
    return success(res, docs.map((d) => ({
      id: d.id, documentId: d.documentId, fileName: d.fileName, fileUrl: d.fileUrl,
      category: d.documentCategory, testDate: d.testDate, labName: d.labName, createdAt: d.createdAt,
    })));
  } catch (err) {
    console.error('HistologyRequest.reportCandidates error:', err);
    return error(res, 'Server error', 500);
  }
};

// ---------------------------------------------------------------------
// GET /api/histology/worklist — results still awaited, clinic-wide (H7, V7)
// ---------------------------------------------------------------------
// Every request still awaiting its result, overdue first (21 days), then the
// longest waiting. ?mine=true → only the ones I requested. Each row names the
// patient by their ACTIVE file (a request made on a since-merged file shows
// under the file it was merged into). Not a single patient's record, so no
// per-patient access log — the same as the lab's pending list.
const worklist = async (req, res) => {
  try {
    const where = { status: 'awaiting' };
    if (req.query.mine === 'true') where.requestedById = req.user.id;
    const rows = await HistologyRequest.findAll({
      where,
      include: [
        { model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName', 'mergedIntoId'] },
        { model: User, as: 'requestedBy', attributes: USER_ATTRS },
      ],
      order: [['visitDate', 'ASC'], ['id', 'ASC']],
      limit: 500,
    });
    const mergedIds = [...new Set(rows.map((r) => r.Patient?.mergedIntoId).filter(Boolean))];
    const canonical = new Map((mergedIds.length ? await Patient.findAll({
      where: { id: { [Op.in]: mergedIds } }, attributes: ['id', 'uhid', 'firstName', 'lastName'],
    }) : []).map((p) => [p.id, p]));
    const today = clinicToday();
    const items = rows.map((r) => {
      const p = r.Patient?.mergedIntoId ? canonical.get(r.Patient.mergedIntoId) || r.Patient : r.Patient;
      const plain = { siteType: r.siteType, thyroidLobe: r.thyroidLobe, noduleLabel: r.noduleLabel, tirads: r.tirads, siteText: r.siteText };
      return {
        id: r.id,
        specimenNumber: r.specimenNumber,
        kind: r.kind,
        site: R.siteSummary(plain, null),
        specimenLabel: R.LABELS.specimen[r.specimenType] || r.specimenType,
        sendTo: r.sendTo,
        visitDate: r.visitDate,
        daysWaiting: R.daysBetween(r.visitDate, today),
        overdue: R.isOverdue(r, today),
        requestedById: r.requestedById,
        requestedByName: userName(r.requestedBy),
        mine: r.requestedById === req.user.id,
        patient: p ? { uhid: p.uhid, name: `${p.firstName || ''} ${p.lastName || ''}`.trim() } : null,
      };
    }).sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (b.daysWaiting - a.daysWaiting) || (a.id - b.id));
    return success(res, {
      items,
      counts: { awaiting: items.length, overdue: items.filter((i) => i.overdue).length },
      overdueDays: R.OVERDUE_DAYS,
    });
  } catch (err) {
    console.error('HistologyRequest.worklist error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = {
  worklist,
  listForPatient, getOne, create, saveResult, cancel, reportCandidates,
  // for the dermatology board and finding detail
  findingInfo, formatRequest, INCLUDE,
};
