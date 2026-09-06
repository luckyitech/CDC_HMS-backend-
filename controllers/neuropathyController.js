const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const {
  FEET, SITES, MODALITIES, gradeValue, averageReadings, monoSummary, overallGrade,
} = require('../constants/neuropathy');
const db = require('../models');

const { NeuropathyStudy, NeuropathyReading, Patient, User, PatientVital } = db;

// Neuropathy Studio — controller.
//
// A study is created as a Draft against a UHID (picked first in the portal, so
// every study is patient-linked from the start), readings are upserted while
// it is a Draft, then `complete` computes the per-foot averages + grades
// SERVER-SIDE from the stored readings and locks the study. Cancel is a
// soft-delete with attribution; nothing is ever destroy()'d.

// ====================================
// HELPER FUNCTIONS
// ====================================

const studyIncludes = [
  { model: Patient, attributes: ['uhid', 'firstName', 'lastName', 'gender', 'dateOfBirth'] },
  { model: User, as: 'performedBy', attributes: ['firstName', 'lastName', 'role'] },
  { model: User, as: 'cancelledBy', attributes: ['firstName', 'lastName', 'role'] },
];

const num = (v) => (v === null || v === undefined ? null : Number(v));

const clinicianName = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : null);

const formatStudy = (study, { withReadings = false } = {}) => {
  const s = study.dataValues || study;
  const out = {
    id: s.id,
    uhid: s.Patient?.uhid || null,
    patientName: s.Patient ? `${s.Patient.firstName} ${s.Patient.lastName}` : null,
    patientGender: s.Patient?.gender || null,
    patientDateOfBirth: s.Patient?.dateOfBirth || null,
    studyDate: s.studyDate,
    protocol: s.protocol,
    status: s.status,
    overallGrade: s.overallGrade || null,
    referral: s.referral,
    performedById: s.performedById,
    performedByName: clinicianName(s.performedBy),
    summary: {
      right: {
        vpt:  { avg: num(s.rightVptAvg),  grade: s.rightVptGrade },
        hot:  { avg: num(s.rightHotAvg),  grade: s.rightHotGrade },
        cold: { avg: num(s.rightColdAvg), grade: s.rightColdGrade },
        mono: { tested: s.rightMonoTested, insensate: s.rightMonoInsensate },
      },
      left: {
        vpt:  { avg: num(s.leftVptAvg),  grade: s.leftVptGrade },
        hot:  { avg: num(s.leftHotAvg),  grade: s.leftHotGrade },
        cold: { avg: num(s.leftColdAvg), grade: s.leftColdGrade },
        mono: { tested: s.leftMonoTested, insensate: s.leftMonoInsensate },
      },
    },
    remarks: s.remarks,
    impression: s.impression,
    rightInterpretation: s.rightInterpretation,
    leftInterpretation: s.leftInterpretation,
    completedAt: s.completedAt,
    reportSavedAt: s.reportSavedAt,
    reportDocumentId: s.reportDocumentId,
    cancelledAt: s.cancelledAt,
    cancelledByName: clinicianName(s.cancelledBy),
    cancelReason: s.cancelReason,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (withReadings) {
    out.readings = (s.NeuropathyReadings || []).map((r) => ({
      foot: r.foot, site: r.site, modality: r.modality, value: num(r.value), omitted: !!r.omitted,
    }));
  }
  return out;
};

/** Load a study the caller may act on; returns [study] or [null, res-error-sent]. */
const loadStudy = async (id, res, { includeReadings = false } = {}) => {
  const include = includeReadings ? [...studyIncludes, { model: NeuropathyReading }] : studyIncludes;
  const study = await NeuropathyStudy.findByPk(id, { include });
  if (!study) { error(res, 'Neuropathy study not found', 404); return null; }
  return study;
};

/** Compute per-foot summaries from a study's readings (the authoritative grading). */
const computeSummary = (readings) => {
  const pick = (foot, modality) => readings
    .filter((r) => r.foot === foot && r.modality === modality && !r.omitted)
    .map((r) => num(r.value));
  const out = {};
  for (const [foot, prefix] of [['R', 'right'], ['L', 'left']]) {
    for (const [modality, key] of [['VPT', 'Vpt'], ['HOT', 'Hot'], ['COLD', 'Cold']]) {
      const avg = averageReadings(modality, pick(foot, modality));
      out[`${prefix}${key}Avg`]   = avg;
      out[`${prefix}${key}Grade`] = gradeValue(modality, avg);
    }
    const m = monoSummary(pick(foot, 'MONO'));
    out[`${prefix}MonoTested`]    = m.tested || null;
    out[`${prefix}MonoInsensate`] = m.tested ? m.insensate : null;
  }
  return out;
};

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * POST /api/neuropathy
 * Create a Draft study for a patient.
 * Body: { uhid, studyDate?, referral? }   Attribution: performedById from JWT.
 */
const create = async (req, res) => {
  try {
    const { uhid, studyDate, referral } = req.body;

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient ${uhid} not found`, 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new studies can be created.', 403);

    const study = await NeuropathyStudy.create({
      PatientId: family.patient.id,
      performedById: req.user.id,
      studyDate: studyDate || clinicToday(),
      protocol: 'plantar',
      status: 'Draft',
      referral: referral || null,
    });

    const full = await NeuropathyStudy.findByPk(study.id, { include: studyIncludes });
    return success(res, formatStudy(full), 201);
  } catch (err) {
    console.error('NeuropathyStudy.create error:', err);
    return error(res, 'Failed to create neuropathy study', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/readings
 * Upsert a batch of site readings on a Draft study.
 * Body: { readings: [{ foot, site, modality, value, omitted? }] }
 */
const saveReadings = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res);
    if (!study) return;
    if (study.status !== 'Draft') return error(res, `Study is ${study.status} and can no longer be edited.`, 409);

    const { readings } = req.body;
    if (!Array.isArray(readings) || !readings.length) return error(res, 'readings must be a non-empty array', 400);

    for (const r of readings) {
      if (!FEET.includes(r.foot)) return error(res, `Invalid foot "${r.foot}"`, 400);
      if (!SITES.includes(r.site)) return error(res, `Invalid site "${r.site}"`, 400);
      if (!MODALITIES.includes(r.modality)) return error(res, `Invalid modality "${r.modality}"`, 400);
      const omitted = !!r.omitted;
      const value = omitted || r.value === null || r.value === undefined || r.value === '' ? null : Number(r.value);
      if (value !== null && Number.isNaN(value)) return error(res, `Invalid value for ${r.foot}/${r.site}/${r.modality}`, 400);
      if (value !== null && r.modality === 'MONO' && ![0, 1].includes(value)) return error(res, 'MONO value must be 0 (not felt) or 1 (felt)', 400);
      if (value !== null && r.modality === 'VPT' && (value < 0 || value > 50)) return error(res, 'VPT must be 0–50 volts', 400);
      if (value !== null && (r.modality === 'HOT' || r.modality === 'COLD') && (value < 0 || value > 50)) return error(res, 'Thermal readings must be 0–50 °C', 400);

      const [row, created] = await NeuropathyReading.findOrCreate({
        where: { NeuropathyStudyId: study.id, foot: r.foot, site: r.site, modality: r.modality },
        defaults: { value, omitted },
      });
      if (!created) await row.update({ value, omitted });
    }

    const full = await loadStudy(study.id, res, { includeReadings: true });
    return success(res, formatStudy(full, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.saveReadings error:', err);
    return error(res, 'Failed to save readings', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/complete
 * Grade the study server-side from its readings and lock it.
 * Body: { remarks?, rightInterpretation?, leftInterpretation?, impression? }
 */
const complete = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res, { includeReadings: true });
    if (!study) return;
    if (study.status !== 'Draft') return error(res, `Study is already ${study.status}.`, 409);

    const readings = study.NeuropathyReadings || [];
    const hasData = readings.some((r) => !r.omitted && r.value !== null && r.value !== undefined);
    if (!hasData) return error(res, 'Record at least one reading before completing the study.', 400);

    const { remarks, impression, rightInterpretation, leftInterpretation } = req.body;
    const summary = computeSummary(readings);
    await study.update({
      ...summary,
      // Final-Result severity, computed the same way the report prints it.
      overallGrade: overallGrade([
        summary.rightVptGrade, summary.leftVptGrade,
        summary.rightHotGrade, summary.leftHotGrade,
        summary.rightColdGrade, summary.leftColdGrade,
      ]),
      remarks: remarks ?? study.remarks,
      impression: impression ?? study.impression,
      rightInterpretation: rightInterpretation ?? study.rightInterpretation,
      leftInterpretation: leftInterpretation ?? study.leftInterpretation,
      status: 'Completed',
      completedAt: new Date(),
    });

    const full = await loadStudy(study.id, res, { includeReadings: true });
    return success(res, formatStudy(full, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.complete error:', err);
    return error(res, 'Failed to complete study', 500);
  }
};

/**
 * GET /api/neuropathy?uhid=…&includeCancelled=1&limit=…
 * With uhid: that patient's studies (merge-aware). Without: recent studies
 * for the portal worklist.
 */
const list = async (req, res) => {
  try {
    const { uhid, includeCancelled } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = {};

    if (uhid) {
      const family = await resolvePatient(uhid);
      if (!family) return error(res, `Patient ${uhid} not found`, 404);
      where.PatientId = { [Op.in]: family.patientIds };
    }
    if (!includeCancelled) where.status = { [Op.ne]: 'Cancelled' };

    const studies = await NeuropathyStudy.findAll({
      where,
      include: studyIncludes,
      order: [['studyDate', 'DESC'], ['createdAt', 'DESC']],
      limit,
    });
    return success(res, studies.map((s) => formatStudy(s)));
  } catch (err) {
    console.error('NeuropathyStudy.list error:', err);
    return error(res, 'Failed to fetch neuropathy studies', 500);
  }
};

/** GET /api/neuropathy/:id — full study with readings. */
const getById = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res, { includeReadings: true });
    if (!study) return;
    return success(res, formatStudy(study, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.getById error:', err);
    return error(res, 'Failed to fetch neuropathy study', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/cancel — soft-delete with attribution.
 * Body: { reason? }
 */
const cancel = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res);
    if (!study) return;
    if (study.status === 'Cancelled') return error(res, 'Study is already cancelled.', 409);

    await study.update({
      status: 'Cancelled',
      cancelledById: req.user.id,
      cancelledAt: new Date(),
      cancelReason: req.body.reason || null,
    });
    const full = await loadStudy(study.id, res);
    return success(res, formatStudy(full));
  } catch (err) {
    console.error('NeuropathyStudy.cancel error:', err);
    return error(res, 'Failed to cancel study', 500);
  }
};

/**
 * PUT /api/neuropathy/:id/report-saved
 * Record that the graded report PDF was filed to the patient's Medical
 * Documents. Idempotent-refusing: a study whose report is already saved returns
 * 409 so a second Save can never create a duplicate document.
 * Body: { documentId? }
 */
const markReportSaved = async (req, res) => {
  try {
    const study = await loadStudy(req.params.id, res);
    if (!study) return;
    if (study.status !== 'Completed') return error(res, 'Only a completed study can have its report saved.', 409);
    if (study.reportSavedAt) return error(res, 'This report has already been saved to the record.', 409);

    const documentId = req.body.documentId === undefined || req.body.documentId === null ? null : Number(req.body.documentId);
    await study.update({ reportSavedAt: new Date(), reportDocumentId: Number.isNaN(documentId) ? null : documentId });

    const full = await loadStudy(study.id, res, { includeReadings: true });
    return success(res, formatStudy(full, { withReadings: true }));
  } catch (err) {
    console.error('NeuropathyStudy.markReportSaved error:', err);
    return error(res, 'Failed to record report save', 500);
  }
};

// ====================================
// ANALYTICS — cross-patient cohort aggregation (live prospective PNS study)
// ====================================
//
// Read-only; doctor/admin only (see routes) — NOT patient-scoped, so no
// logPatientAccess. Feeds the Neuropathy Suite -> Analytics tab. Rules:
//  * MERGE-AWARE: a study's identity is its canonical patient
//    (mergedIntoId || Patient.id), so a merged duplicate never double-counts.
//  * DECISION #3: prevalence / severity / laterality / heatmap are counted PER
//    PATIENT (that patient's latest completed study); throughput PER STUDY.
//  * Grades are RE-DERIVED from raw readings via the shared constants helpers,
//    so analytics == NeuropathyReport (and the thermal-0 exclusion applies).

const pickValues = (readings, foot, modality) => readings
  .filter((r) => r.foot === foot && r.modality === modality && !r.omitted)
  .map((r) => (r.value === null || r.value === undefined ? null : Number(r.value)));

const gradeStudy = (readings) => {
  const feet = {};
  for (const [foot, key] of [['R', 'right'], ['L', 'left']]) {
    const f = {};
    for (const m of ['VPT', 'HOT', 'COLD']) {
      const avg = averageReadings(m, pickValues(readings, foot, m));
      f[m] = { avg, grade: gradeValue(m, avg) };
    }
    f.MONO = monoSummary(pickValues(readings, foot, 'MONO'));
    feet[key] = f;
  }
  const overall = overallGrade([
    feet.right.VPT.grade, feet.left.VPT.grade,
    feet.right.HOT.grade, feet.left.HOT.grade,
    feet.right.COLD.grade, feet.left.COLD.grade,
  ]);
  return { feet, overall };
};

const canonicalId = (patient) => (patient && (patient.mergedIntoId || patient.id)) || null;

const ageFrom = (dob) => {
  if (!dob) return null;
  const d = new Date(dob); if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const mm = now.getMonth() - d.getMonth();
  if (mm < 0 || (mm === 0 && now.getDate() < d.getDate())) a -= 1;
  return a >= 0 && a < 130 ? a : null;
};
const bandForAge = (a) => (a === null ? 'Unknown' : a < 40 ? '<40' : a <= 65 ? '40-65' : '>65');
const monthKey = (dt) => { const d = new Date(dt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const mean1 = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
const median = (arr) => {
  const a = arr.filter((n) => n !== null && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 10) / 10;
};

/** GET /api/neuropathy/analytics/overview — Phase 1: prevalence + throughput. */
const analyticsOverview = async (req, res) => {
  try {
    const { from, to, sex, performedById } = req.query;
    const ageBandFilter = req.query.ageBand;

    const studies = await NeuropathyStudy.findAll({
      where: { status: 'Completed' },   // signed studies only — Drafts/Cancelled are never counted
      include: [
        { model: Patient, attributes: ['id', 'uhid', 'mergedIntoId', 'status', 'gender', 'dateOfBirth'] },
        { model: User, as: 'performedBy', attributes: ['id', 'firstName', 'lastName', 'role'] },
        { model: NeuropathyReading },
      ],
      order: [['completedAt', 'ASC'], ['studyDate', 'ASC'], ['createdAt', 'ASC']],
    });

    const performerMap = new Map();
    for (const s of studies) if (s.performedBy) performerMap.set(s.performedBy.id, clinicianName(s.performedBy));
    const performers = [...performerMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

    const inRange = (s) => {
      const day = s.completedAt ? new Date(s.completedAt) : new Date(s.studyDate);
      if (from && day < new Date(from)) return false;
      if (to && day > new Date(`${to}T23:59:59`)) return false;
      return true;
    };
    const shaped = studies
      .filter((s) => s.Patient)
      .filter(inRange)
      .filter((s) => !sex || s.Patient.gender === sex)
      .filter((s) => !performedById || String(s.performedById) === String(performedById))
      .map((s) => {
        const age = ageFrom(s.Patient.dateOfBirth);
        return {
          id: s.id,
          status: s.status,
          cid: canonicalId(s.Patient),
          gender: s.Patient.gender || 'Unknown',
          age,
          ageBand: bandForAge(age),
          completedAt: s.completedAt,
          studyDate: s.studyDate,
          readings: (s.NeuropathyReadings || []).map((r) => ({ foot: r.foot, site: r.site, modality: r.modality, value: r.value, omitted: r.omitted })),
        };
      })
      .filter((s) => !ageBandFilter || s.ageBand === ageBandFilter);

    const completed = shaped.filter((s) => s.cid);

    // latest completed study per canonical patient (loaded ASC -> last wins)
    const latestByPatient = new Map();
    for (const s of completed) latestByPatient.set(s.cid, s);
    const latest = [...latestByPatient.values()].map((s) => ({ ...s, ...gradeStudy(s.readings) }));

    const perPatientCount = {};
    for (const s of completed) perPatientCount[s.cid] = (perPatientCount[s.cid] || 0) + 1;

    // prevalence (per patient, overall Final-Result grade)
    const prevalence = { Normal: 0, Mild: 0, Moderate: 0, Severe: 0, ungraded: 0 };
    const worstFootVpt = [];
    for (const s of latest) {
      if (s.overall) prevalence[s.overall] += 1; else prevalence.ungraded += 1;
      const v = [s.feet.right.VPT.avg, s.feet.left.VPT.avg].filter((x) => x !== null);
      if (v.length) worstFootVpt.push(Math.max(...v));
    }
    const graded = prevalence.Normal + prevalence.Mild + prevalence.Moderate + prevalence.Severe;
    const dpnPrevalencePct = graded ? Math.round(((graded - prevalence.Normal) / graded) * 100) : null;

    // severity by modality (per patient, worse foot); mono felt/not-felt
    const empty = () => ({ Normal: 0, Mild: 0, Moderate: 0, Severe: 0 });
    const byModality = { VPT: empty(), HOT: empty(), COLD: empty(), MONO: { felt: 0, notFelt: 0 } };
    for (const s of latest) {
      for (const m of ['VPT', 'HOT', 'COLD']) {
        const worse = overallGrade([s.feet.right[m].grade, s.feet.left[m].grade]);
        if (worse) byModality[m][worse] += 1;
      }
      const insensate = (s.feet.right.MONO.insensate || 0) + (s.feet.left.MONO.insensate || 0);
      const tested = (s.feet.right.MONO.tested || 0) + (s.feet.left.MONO.tested || 0);
      if (tested) { if (insensate > 0) byModality.MONO.notFelt += 1; else byModality.MONO.felt += 1; }
    }

    // laterality (per patient, VPT)
    const lat = { R: { vpt: [], abn: 0, n: 0 }, L: { vpt: [], abn: 0, n: 0 } };
    for (const s of latest) {
      for (const [foot, key] of [['R', 'right'], ['L', 'left']]) {
        const g = s.feet[key].VPT;
        if (g.avg !== null) { lat[foot].vpt.push(g.avg); lat[foot].n += 1; if (g.grade && g.grade !== 'Normal') lat[foot].abn += 1; }
      }
    }
    const laterality = {};
    for (const foot of ['R', 'L']) laterality[foot] = { meanVpt: mean1(lat[foot].vpt), abnormalPct: lat[foot].n ? Math.round((lat[foot].abn / lat[foot].n) * 100) : null, n: lat[foot].n };

    // plantar-site burden: mean VPT per foot x site (per patient latest)
    const siteAgg = {};
    for (const foot of FEET) { siteAgg[foot] = {}; for (const site of SITES) siteAgg[foot][site] = []; }
    for (const s of latest) {
      for (const r of s.readings) {
        if (r.modality !== 'VPT' || r.omitted || r.value === null || r.value === undefined) continue;
        if (siteAgg[r.foot] && siteAgg[r.foot][r.site]) siteAgg[r.foot][r.site].push(Number(r.value));
      }
    }
    const siteHeatmap = {};
    for (const foot of FEET) {
      siteHeatmap[foot] = {};
      for (const site of SITES) {
        const vals = siteAgg[foot][site];
        siteHeatmap[foot][site] = vals.length
          ? { meanVpt: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), n: vals.length }
          : { meanVpt: null, n: 0 };
      }
    }

    // throughput / accrual (per study)
    const monthCounts = {}; const firstSeen = {};
    for (const s of completed) {
      const k = monthKey(s.completedAt || s.studyDate);
      monthCounts[k] = (monthCounts[k] || 0) + 1;
      if (!firstSeen[s.cid] || k < firstSeen[s.cid]) firstSeen[s.cid] = k;
    }
    const newByMonth = {};
    for (const cid of Object.keys(firstSeen)) newByMonth[firstSeen[cid]] = (newByMonth[firstSeen[cid]] || 0) + 1;

    const months = [...new Set([...Object.keys(monthCounts), ...Object.keys(newByMonth)])].sort();
    let cum = 0;
    const throughput = months.map((m) => { cum += (newByMonth[m] || 0); return { month: m, completed: monthCounts[m] || 0, newPatients: newByMonth[m] || 0, cumulativePatients: cum }; });

    return success(res, {
      generatedAt: new Date(),
      filters: { from: from || null, to: to || null, sex: sex || null, ageBand: ageBandFilter || null, performedById: performedById || null },
      performers,
      totals: {
        patientsScreened: latestByPatient.size,
        studiesCompleted: completed.length,
        repeatPatients: Object.values(perPatientCount).filter((n) => n > 1).length,
        dpnPrevalencePct,
        medianWorstVpt: median(worstFootVpt),
      },
      prevalence,
      byModality,
      laterality,
      siteHeatmap,
      throughput,
    });
  } catch (err) {
    console.error('NeuropathyStudy.analyticsOverview error:', err);
    return error(res, 'Failed to build neuropathy analytics', 500);
  }
};

const AGE_BAND_ORDER = ['<40', '40-65', '>65', 'Unknown'];

/**
 * GET /api/neuropathy/analytics/coverage — Phase 2: screening coverage against
 * the diabetic population. DECISION #2: the denominator is every ACTIVE,
 * canonical (non-merged) registered patient — the clinic is a diabetes centre,
 * so active registrations stand in for "diabetic population" (the diagnosis text
 * is free-form and unreliable to filter on). Numerator = active canonical
 * patients with >=1 Completed study (merge-aware: a study written under a since-
 * merged record counts for the surviving patient). Doctor/admin only.
 */
const analyticsCoverage = async (req, res) => {
  try {
    const patients = await Patient.findAll({ attributes: ['id', 'mergedIntoId', 'status', 'gender', 'dateOfBirth'] });
    const canonById = new Map(patients.map((p) => [p.id, p.mergedIntoId || p.id]));

    // Active canonical patients = the denominator, with subgroup metadata.
    const activeCanon = new Map();
    for (const p of patients) {
      if (p.status === 'Active' && !p.mergedIntoId) {
        activeCanon.set(p.id, { gender: p.gender || 'Unknown', ageBand: bandForAge(ageFrom(p.dateOfBirth)) });
      }
    }

    // Canonical patients that have been screened (any Completed study).
    const completed = await NeuropathyStudy.findAll({ where: { status: 'Completed' }, attributes: ['PatientId'] });
    const screenedCanon = new Set();
    for (const st of completed) screenedCanon.add(canonById.get(st.PatientId) || st.PatientId);

    const bySex = {}; const byAge = {};
    let screenedActive = 0;
    for (const [id, meta] of activeCanon) {
      bySex[meta.gender] = bySex[meta.gender] || { screened: 0, total: 0 };
      byAge[meta.ageBand] = byAge[meta.ageBand] || { screened: 0, total: 0 };
      bySex[meta.gender].total += 1;
      byAge[meta.ageBand].total += 1;
      if (screenedCanon.has(id)) {
        screenedActive += 1;
        bySex[meta.gender].screened += 1;
        byAge[meta.ageBand].screened += 1;
      }
    }

    const rows = (obj, key, order) => Object.entries(obj)
      .map(([k, v]) => ({ [key]: k, screened: v.screened, total: v.total, pct: v.total ? Math.round((v.screened / v.total) * 100) : 0 }))
      .sort((a, b) => (order ? order.indexOf(a[key]) - order.indexOf(b[key]) : b.total - a.total));

    const registeredActive = activeCanon.size;
    return success(res, {
      generatedAt: new Date(),
      denominatorLabel: 'Active registered patients',
      registeredActive,
      screenedActive,
      screenedEver: screenedCanon.size,
      notScreened: Math.max(registeredActive - screenedActive, 0),
      coveragePct: registeredActive ? Math.round((screenedActive / registeredActive) * 100) : null,
      bySex: rows(bySex, 'sex'),
      byAge: rows(byAge, 'ageBand', AGE_BAND_ORDER),
    });
  } catch (err) {
    console.error('NeuropathyStudy.analyticsCoverage error:', err);
    return error(res, 'Failed to build coverage analytics', 500);
  }
};

const HBA1C_BANDS = [
  { key: '<5.7',    test: (v) => v < 5.7 },
  { key: '5.7-6.4', test: (v) => v >= 5.7 && v < 6.5 },
  { key: '6.5-10',  test: (v) => v >= 6.5 && v <= 10 },
  { key: '>10',     test: (v) => v > 10 },
];
const DURATION_BANDS = [
  { key: '<5y',   test: (y) => y < 5 },
  { key: '5-10y', test: (y) => y >= 5 && y <= 10 },
  { key: '>10y',  test: (y) => y > 10 },
];
const bandOf = (bands, v) => ((v === null || v === undefined || Number.isNaN(Number(v))) ? 'Unknown' : (bands.find((b) => b.test(Number(v)))?.key || 'Unknown'));
const yearsSince = (fromDate, toDate) => {
  if (!fromDate) return null;
  const a = new Date(fromDate); const b = toDate ? new Date(toDate) : new Date();
  if (Number.isNaN(a.getTime())) return null;
  const y = (b - a) / (365.25 * 24 * 3600 * 1000);
  return y >= 0 && y < 100 ? Math.floor(y) : null;
};
const parseHba1c = (raw) => {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(/[\d.]+/);
  if (!m) return null;
  const v = Number(m[0]);
  return (Number.isNaN(v) || v <= 0 || v > 20) ? null : v;
};

/**
 * GET /api/neuropathy/analytics/correlation — Phase 3: risk correlation.
 * Per patient (latest completed study, merge-aware): overall DPN (any grade >=
 * Mild) vs latest HbA1c (PatientVital across the family; falls back to
 * Patient.hba1c), diabetes duration (Patient.diagnosisDate -> study date), age,
 * and sex. Each factor is aggregated with ITS OWN denominator (HbA1c and
 * diagnosis-date aren't recorded for everyone), and `available` reports how many
 * patients had that factor known. Also returns de-identified per-patient rows
 * for the research CSV export (no UHID/name/DOB). Doctor/admin only.
 */
const analyticsCorrelation = async (req, res) => {
  try {
    const patients = await Patient.findAll({ attributes: ['id', 'mergedIntoId', 'gender', 'dateOfBirth', 'diagnosisDate', 'hba1c'] });
    const canonById = new Map(patients.map((p) => [p.id, p.mergedIntoId || p.id]));
    const patientById = new Map(patients.map((p) => [p.id, p]));
    const membersByCanon = new Map();
    for (const p of patients) { const c = p.mergedIntoId || p.id; if (!membersByCanon.has(c)) membersByCanon.set(c, []); membersByCanon.get(c).push(p.id); }

    const studies = await NeuropathyStudy.findAll({
      where: { status: 'Completed' },
      include: [{ model: NeuropathyReading }],
      order: [['completedAt', 'ASC'], ['studyDate', 'ASC'], ['createdAt', 'ASC']],
    });
    const latestByCanon = new Map();
    for (const st of studies) latestByCanon.set(canonById.get(st.PatientId) || st.PatientId, st);

    // latest HbA1c per canonical patient (merge-aware across the family)
    const memberIds = [];
    for (const c of latestByCanon.keys()) for (const id of (membersByCanon.get(c) || [c])) memberIds.push(id);
    const vitals = memberIds.length ? await PatientVital.findAll({
      where: { PatientId: { [Op.in]: memberIds }, hba1c: { [Op.ne]: null } },
      attributes: ['PatientId', 'hba1c', 'recordedAt'],
      order: [['recordedAt', 'DESC']],
    }) : [];
    const hba1cByCanon = new Map();
    for (const v of vitals) { const c = canonById.get(v.PatientId) || v.PatientId; if (!hba1cByCanon.has(c)) hba1cByCanon.set(c, parseHba1c(v.hba1c)); }

    const rows = [];
    for (const [c, st] of latestByCanon) {
      const p = patientById.get(c) || {};
      const graded = gradeStudy((st.NeuropathyReadings || []).map((r) => ({ foot: r.foot, site: r.site, modality: r.modality, value: r.value, omitted: r.omitted })));
      const overall = graded.overall;
      let hb = hba1cByCanon.get(c);
      if (hb === undefined || hb === null) hb = parseHba1c(p.hba1c);
      rows.push({
        overall,
        dpn: overall ? (overall !== 'Normal') : null,
        hba1c: hb ?? null,
        durationYears: yearsSince(p.diagnosisDate, st.completedAt || st.studyDate),
        age: ageFrom(p.dateOfBirth),
        sex: p.gender || 'Unknown',
        feet: graded.feet,
        studyDate: st.studyDate,
      });
    }

    const aggregate = (bandFn, order) => {
      const map = new Map(); let known = 0;
      for (const r of rows) {
        if (r.dpn === null) continue;
        const band = bandFn(r);
        if (band === 'Unknown') continue;
        known += 1;
        if (!map.has(band)) map.set(band, { n: 0, dpn: 0 });
        const g = map.get(band); g.n += 1; if (r.dpn) g.dpn += 1;
      }
      const bands = [...map.entries()]
        .map(([band, g]) => ({ band, n: g.n, dpn: g.dpn, prevalencePct: g.n ? Math.round((g.dpn / g.n) * 100) : 0 }))
        .sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band));
      return { available: known, bands };
    };

    const exportRows = rows.map((r, i) => ({
      ref: `P${String(i + 1).padStart(3, '0')}`,
      age: r.age ?? '', sex: r.sex,
      diabetesDurationYears: r.durationYears ?? '',
      latestHba1c: r.hba1c ?? '',
      overallGrade: r.overall || '',
      vptR: r.feet.right.VPT.avg ?? '', vptL: r.feet.left.VPT.avg ?? '',
      coldR: r.feet.right.COLD.avg ?? '', coldL: r.feet.left.COLD.avg ?? '',
      hotR: r.feet.right.HOT.avg ?? '', hotL: r.feet.left.HOT.avg ?? '',
      monoInsensateR: r.feet.right.MONO.insensate ?? '', monoInsensateL: r.feet.left.MONO.insensate ?? '',
      studyMonth: monthKey(r.studyDate),
    }));

    return success(res, {
      generatedAt: new Date(),
      patientsWithGradedStudy: rows.filter((r) => r.dpn !== null).length,
      hba1c:    aggregate((r) => bandOf(HBA1C_BANDS, r.hba1c), ['<5.7', '5.7-6.4', '6.5-10', '>10']),
      duration: aggregate((r) => bandOf(DURATION_BANDS, r.durationYears), ['<5y', '5-10y', '>10y']),
      age:      aggregate((r) => bandForAge(r.age), ['<40', '40-65', '>65']),
      sex:      aggregate((r) => (['Male', 'Female', 'Other'].includes(r.sex) ? r.sex : 'Unknown'), ['Female', 'Male', 'Other']),
      exportRows,
    });
  } catch (err) {
    console.error('NeuropathyStudy.analyticsCorrelation error:', err);
    return error(res, 'Failed to build correlation analytics', 500);
  }
};

const worstVpt = (feet) => {
  const v = [feet.right.VPT.avg, feet.left.VPT.avg].filter((x) => x !== null && x !== undefined);
  return v.length ? Math.max(...v) : null;
};

/**
 * GET /api/neuropathy/analytics/longitudinal — Phase 4: progression over time.
 * Patients with >=2 Completed studies (merge-aware). Per patient: worst-foot VPT
 * at each visit (trajectory), and latest-vs-previous overall grade -> worsened /
 * stable / improved; plus the median interval between the last two studies.
 * Sparse until the clinic re-screens. Doctor/admin only.
 */
const analyticsLongitudinal = async (req, res) => {
  try {
    const patients = await Patient.findAll({ attributes: ['id', 'mergedIntoId'] });
    const canonById = new Map(patients.map((p) => [p.id, p.mergedIntoId || p.id]));

    const studies = await NeuropathyStudy.findAll({
      where: { status: 'Completed' },
      include: [{ model: NeuropathyReading }],
      order: [['completedAt', 'ASC'], ['studyDate', 'ASC'], ['createdAt', 'ASC']],
    });
    const byCanon = new Map();
    for (const st of studies) {
      const c = canonById.get(st.PatientId) || st.PatientId;
      if (!byCanon.has(c)) byCanon.set(c, []);
      byCanon.get(c).push(st);
    }

    const RANK = { Normal: 0, Mild: 1, Moderate: 2, Severe: 3 };
    const outcomes = { worsened: 0, stable: 0, improved: 0 };
    const intervals = [];
    const trajectories = [];
    let maxVisits = 0;

    for (const list of byCanon.values()) {
      if (list.length < 2) continue;
      const graded = list.map((st) => {
        const g = gradeStudy((st.NeuropathyReadings || []).map((r) => ({ foot: r.foot, site: r.site, modality: r.modality, value: r.value, omitted: r.omitted })));
        return { date: st.completedAt || st.studyDate, overall: g.overall, vpt: worstVpt(g.feet) };
      });
      maxVisits = Math.max(maxVisits, graded.length);

      const last = graded[graded.length - 1]; const prev = graded[graded.length - 2];
      const days = Math.round((new Date(last.date) - new Date(prev.date)) / (24 * 3600 * 1000));
      if (days >= 0) intervals.push(days);

      let direction = 'stable';
      if (last.overall && prev.overall) {
        if (RANK[last.overall] > RANK[prev.overall]) { outcomes.worsened += 1; direction = 'worsened'; }
        else if (RANK[last.overall] < RANK[prev.overall]) { outcomes.improved += 1; direction = 'improved'; }
        else outcomes.stable += 1;
      } else outcomes.stable += 1;

      trajectories.push({ direction, points: graded.map((g, i) => ({ visit: i + 1, vpt: g.vpt, grade: g.overall })) });
    }

    const median = (arr) => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
    const medDays = median(intervals);

    return success(res, {
      generatedAt: new Date(),
      reScreened: trajectories.length,
      outcomes,
      newOrWorseningPct: trajectories.length ? Math.round((outcomes.worsened / trajectories.length) * 100) : null,
      medianIntervalDays: medDays,
      medianIntervalMonths: medDays !== null ? Math.round((medDays / 30.44) * 10) / 10 : null,
      maxVisits,
      trajectories,
    });
  } catch (err) {
    console.error('NeuropathyStudy.analyticsLongitudinal error:', err);
    return error(res, 'Failed to build longitudinal analytics', 500);
  }
};

module.exports = { create, saveReadings, complete, list, getById, cancel, markReportSaved, analyticsOverview, analyticsCoverage, analyticsCorrelation, analyticsLongitudinal };
