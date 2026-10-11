// =====================================================================
// Histology / cytology — pure rules (Dermatology Phase 3, 7 Oct 2026). No
// database here, so every rule is unit-tested in tests/histology.test.js.
//
// A REQUEST names what was taken and from where; the RESULT is typed by the
// doctor when the report comes back (decision H4). The tool is general — a
// skin finding is one specimen source; a thyroid nodule (CNB / FNAC), a lymph
// node or any other site are the others (D11).
//
// Every field a report would group by (kind, site, specimen type, TI-RADS,
// margins, Bethesda, category) is its own closed-list column — never JSON.
// =====================================================================

const KINDS = ['histology', 'cytology'];
const SITE_TYPES = ['skin', 'thyroid', 'lymph_node', 'other'];
const TISSUE_TYPES = ['punch', 'shave', 'incisional', 'excision', 'core_needle', 'other'];
const CYTO_TYPES = ['fnac', 'brushings', 'fluid', 'other'];
const SPECIMEN_TYPES = [...new Set([...TISSUE_TYPES, ...CYTO_TYPES])];
// The specimen types that are a skin biopsy — requesting one of these from a
// skin finding offers "also record the biopsy as a procedure" (H9).
const SKIN_BIOPSY_TYPES = ['punch', 'shave', 'incisional', 'excision'];
const FIXATIVES = ['formalin', 'fresh', 'slides', 'cytolyt', 'other'];
const LOBES = ['right', 'left', 'isthmus'];
const TIRADS = ['TR1', 'TR2', 'TR3', 'TR4', 'TR5'];
const MARGINS = ['clear', 'close', 'involved', 'not_assessed'];
const BETHESDA = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const CYTO_CATEGORIES = ['non_diagnostic', 'benign', 'atypical', 'suspicious', 'malignant'];
const STATUSES = ['awaiting', 'resulted', 'cancelled'];

// Overdue: no result this many days after the request (H7).
const OVERDUE_DAYS = 21;

const LABELS = {
  specimen: {
    punch: 'Punch biopsy', shave: 'Shave biopsy', incisional: 'Incisional biopsy', excision: 'Excision biopsy',
    core_needle: 'Core needle biopsy (CNB)', fnac: 'FNAC', brushings: 'Brushings', fluid: 'Fluid', other: 'Other',
  },
  site: { skin: 'Skin finding', thyroid: 'Thyroid nodule', lymph_node: 'Lymph node', other: 'Other site' },
  lobe: { right: 'Right lobe', left: 'Left lobe', isthmus: 'Isthmus' },
};

// The lab request each kind raises (H3) — the lab catalogue may price it.
const LAB_TEST_NAME = { histology: 'Histopathology', cytology: 'Cytology' };
const NUMBER_PREFIX = { histology: 'HP', cytology: 'CY' };

// The result fields a correction may change, in the order the trail shows.
const RESULT_FIELDS = ['resultDiagnosis', 'margins', 'marginMm', 'bethesda', 'cytologyCategory',
  'resultComment', 'reportDate', 'reportDocumentId'];

const fail = (message, field) => ({ ok: false, message, field });

const text = (v, max) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? undefined : t;
};
const pick = (v, allowed) => (v === undefined || v === null || v === '' ? null : (allowed.includes(v) ? v : undefined));
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/**
 * Validate a new request. Returns { ok, value } or { ok:false, message, field }.
 * `findingId` is only checked for shape here; the controller checks the
 * finding belongs to this patient and the Dermatology module is on.
 */
const cleanRequest = (body = {}) => {
  const kind = pick(body.kind, KINDS);
  if (!kind) return fail('Choose histology or cytology', 'kind');
  const siteType = pick(body.siteType, SITE_TYPES);
  if (!siteType) return fail('Say where the specimen is from', 'siteType');

  const allowedTypes = kind === 'histology' ? TISSUE_TYPES : CYTO_TYPES;
  const specimenType = pick(body.specimenType, allowedTypes);
  if (!specimenType) return fail(`Choose a ${kind} specimen type`, 'specimenType');

  const value = {
    kind, siteType, specimenType,
    findingId: null, thyroidLobe: null, noduleLabel: null, tirads: null, siteText: null,
  };

  if (siteType === 'skin') {
    const id = Number(body.findingId);
    if (!Number.isInteger(id) || id <= 0) return fail('Choose the skin finding the specimen is from', 'findingId');
    value.findingId = id;
  }
  if (siteType === 'thyroid') {
    value.thyroidLobe = pick(body.thyroidLobe, LOBES);
    if (!value.thyroidLobe) return fail('Choose the lobe', 'thyroidLobe');
    value.noduleLabel = text(body.noduleLabel, 80);
    if (value.noduleLabel === undefined) return fail('Nodule label is too long (80 characters)', 'noduleLabel');
    value.tirads = pick(body.tirads, TIRADS);
    if (value.tirads === undefined) return fail('TI-RADS must be TR1 to TR5', 'tirads');
  }
  // Exact site: required for a lymph node or other site; optional detail otherwise.
  value.siteText = text(body.siteText, 200);
  if (value.siteText === undefined) return fail('Site description is too long (200 characters)', 'siteText');
  if ((siteType === 'lymph_node' || siteType === 'other') && !value.siteText) {
    return fail('Describe the site', 'siteText');
  }

  if (body.pieces === undefined || body.pieces === null || body.pieces === '') value.pieces = null;
  else {
    const n = Number(body.pieces);
    if (!Number.isInteger(n) || n < 1 || n > 50) return fail('Passes / pieces must be a whole number from 1 to 50', 'pieces');
    value.pieces = n;
  }
  value.fixative = pick(body.fixative, FIXATIVES);
  if (value.fixative === undefined) return fail('Unknown fixative', 'fixative');

  value.clinicalDetails = text(body.clinicalDetails, 4000);
  if (value.clinicalDetails === undefined) return fail('Clinical details are too long', 'clinicalDetails');
  if (!value.clinicalDetails) return fail('Give the clinical details and question for the pathologist', 'clinicalDetails');
  value.sendTo = text(body.sendTo, 150);
  if (value.sendTo === undefined) return fail('Laboratory name is too long (150 characters)', 'sendTo');

  value.alsoRecordProcedure = body.alsoRecordProcedure === true;
  return { ok: true, value };
};

/**
 * Which result shape a request takes (H4):
 *   histology                → diagnosis (required) + margins
 *   cytology of the thyroid  → Bethesda category (required)
 *   any other cytology       → category (required)
 */
const resultShape = (request) => {
  if (request.kind === 'histology') return 'histology';
  return request.siteType === 'thyroid' ? 'bethesda' : 'cytology';
};

/**
 * Validate a result. Fields that do not belong to the request's shape are
 * forced to null, so a cytology result never carries stray margins.
 */
const cleanResult = (request, body = {}) => {
  const shape = resultShape(request);
  const value = {
    resultDiagnosis: null, margins: null, marginMm: null, bethesda: null, cytologyCategory: null,
  };
  value.resultDiagnosis = text(body.resultDiagnosis, 2000);
  if (value.resultDiagnosis === undefined) return fail('Diagnosis is too long', 'resultDiagnosis');

  if (shape === 'histology') {
    if (!value.resultDiagnosis) return fail('Type the histological diagnosis', 'resultDiagnosis');
    value.margins = pick(body.margins, MARGINS);
    if (value.margins === undefined) return fail('Unknown margin status', 'margins');
    if (body.marginMm !== undefined && body.marginMm !== null && body.marginMm !== '') {
      const mm = Math.round(Number(body.marginMm) * 10) / 10;
      if (!Number.isFinite(mm) || mm < 0 || mm > 500) return fail('Closest margin must be 0 to 500 mm', 'marginMm');
      if (!value.margins || value.margins === 'not_assessed') return fail('Give the margin status with a margin distance', 'margins');
      value.marginMm = mm;
    }
  } else if (shape === 'bethesda') {
    value.bethesda = pick(body.bethesda, BETHESDA);
    if (!value.bethesda) return fail('Choose the Bethesda category (I–VI)', 'bethesda');
  } else {
    value.cytologyCategory = pick(body.cytologyCategory, CYTO_CATEGORIES);
    if (!value.cytologyCategory) return fail('Choose the cytology category', 'cytologyCategory');
  }

  value.resultComment = text(body.resultComment, 4000);
  if (value.resultComment === undefined) return fail('Comment is too long', 'resultComment');

  if (body.reportDate === undefined || body.reportDate === null || body.reportDate === '') value.reportDate = null;
  else if (!isDate(body.reportDate)) return fail('Report date must be a date', 'reportDate');
  else value.reportDate = body.reportDate;

  if (body.reportDocumentId === undefined || body.reportDocumentId === null || body.reportDocumentId === '') {
    value.reportDocumentId = null;
  } else {
    const id = Number(body.reportDocumentId);
    if (!Number.isInteger(id) || id <= 0) return fail('Unknown report document', 'reportDocumentId');
    value.reportDocumentId = id;
  }
  return { ok: true, value, shape };
};

/** Days between the request day and today (both YYYY-MM-DD clinic days). */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const isOverdue = (request, today) => request.status === 'awaiting'
  && !!request.visitDate && daysBetween(request.visitDate, today) > OVERDUE_DAYS;

/** One line for the result, as lists and the finding show it. */
const resultSummary = (r) => {
  if (r.status !== 'resulted') return null;
  if (r.bethesda) return `Bethesda ${r.bethesda}${r.resultDiagnosis ? ` — ${r.resultDiagnosis}` : ''}`;
  if (r.cytologyCategory) {
    const cat = r.cytologyCategory.replace('_', '-');
    return `${cat.charAt(0).toUpperCase()}${cat.slice(1)}${r.resultDiagnosis ? ` — ${r.resultDiagnosis}` : ''}`;
  }
  const m = r.margins && r.margins !== 'not_assessed'
    ? `; margins ${r.margins}${r.marginMm != null ? ` (${Number(r.marginMm)} mm)` : ''}` : '';
  return `${r.resultDiagnosis || ''}${m}`;
};

/** Short "where from" line: "Right lobe, R2 lower pole (TR5)" / "#001 left cheek" etc. */
const siteSummary = (r, findingLabel = null) => {
  if (r.siteType === 'thyroid') {
    const bits = [LABELS.lobe[r.thyroidLobe] || 'Thyroid'];
    if (r.noduleLabel) bits.push(r.noduleLabel);
    let s = `Thyroid — ${bits.join(', ')}`;
    if (r.tirads) s += ` (${r.tirads})`;
    return s;
  }
  if (r.siteType === 'skin') return `Skin${findingLabel ? ` — ${findingLabel}` : ''}${r.siteText ? `, ${r.siteText}` : ''}`;
  return `${r.siteType === 'lymph_node' ? 'Lymph node' : 'Site'} — ${r.siteText || ''}`;
};

/** May this user correct the result without a reason? The resulter, the same clinic day. */
const resultChangeMode = (request, userId, today) => (
  request.resultById === userId && request.resultAt && request.resultDay === today ? 'edit' : 'amend'
);

module.exports = {
  KINDS, SITE_TYPES, TISSUE_TYPES, CYTO_TYPES, SPECIMEN_TYPES, SKIN_BIOPSY_TYPES, FIXATIVES, LOBES, TIRADS,
  MARGINS, BETHESDA, CYTO_CATEGORIES, STATUSES, OVERDUE_DAYS, LABELS, LAB_TEST_NAME, NUMBER_PREFIX, RESULT_FIELDS,
  cleanRequest, cleanResult, resultShape, isOverdue, daysBetween, resultSummary, siteSummary, resultChangeMode,
};
