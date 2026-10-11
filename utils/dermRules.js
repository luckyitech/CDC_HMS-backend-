// =====================================================================
// Dermatology — pure rules (Phase 1, 7 Oct 2026). No database here, so every
// rule is unit-tested in tests/dermatology.test.js.
//
// The record is a set of persistent FINDINGS (a lesion, a rash, an ulcer…)
// numbered per patient, each with one OBSERVATION per clinic day it was
// examined. A finding not opened at a visit gets no observation that day —
// it reads "Not examined", never a silent copy of last time (decision D6).
//
// Sizes are TYPED in millimetres with how they were measured (D5). Nothing in
// the HMS ever derives a size from a photograph: a photo has no scale.
//
// Multi-choice fields (colours, symptoms) are stored as a comma-separated list
// of fixed tokens in a VARCHAR, not a JSON column: same answer on MariaDB and
// MySQL 8, and still searchable with LIKE. Everything a report would group by
// (type, status, morphology, size, diagnosis, plan) is its own column.
// =====================================================================

const { isRegion } = require('./dermRegions');
const exam = require('./dermExam');

const FINDING_TYPES = ['lesion', 'rash', 'ulcer', 'scar', 'pigmentation', 'hair_loss', 'nail', 'other'];
const STATUS_TODAY  = ['new', 'improved', 'stable', 'worsened', 'resolved', 'recurrence'];
// The fixed words now live in utils/dermExam (9 Oct 2026); these names are kept
// for older callers. Any of them also takes a typed "Other" word.
const MORPHOLOGY    = exam.CHOICE_FIELDS.morphology;
const BORDERS       = exam.CHOICE_FIELDS.border;
const SURFACES      = exam.CHOICE_FIELDS.surface;
const COLOURS       = exam.CHOICE_FIELDS.colours;
const SYMPTOMS      = exam.CHOICE_FIELDS.symptoms;
const PLANS         = exam.CHOICE_FIELDS.plan;
const MEASURED_BY   = ['ruler', 'dermatoscope', 'estimated'];

const MAX_MM = 2000;          // 2 m — anything larger is a typing slip
const MAX_REGIONS = 44;   // every area on the map (Emu, 10 Oct 2026; was 20)

// The observation fields an amendment may change, in the order the trail shows.
// 9 Oct 2026: plus the structured examination (utils/dermExam.LOOK_EXAM_KEYS)
// and the size range.
const OBSERVATION_FIELDS = ['statusToday', 'lengthMm', 'widthMm', 'depthMm', 'measuredBy', 'sizeMinMm', 'sizeMaxMm',
  'morphology', 'colours', 'symptoms', 'description', 'diagnosis', 'differential', 'plan',
  'planNote', 'reviewIn', ...exam.LOOK_EXAM_KEYS];
const FINDING_FIELDS = ['type', 'typeOther', 'title', 'exactSite', 'firstNoticed', 'concern'];
// Fields no longer on the form (8 Oct 2026: diagnosis lives in the consultation's
// diagnosis list; review is the follow-up appointment). Old values are kept —
// they are only written when a request actually sends them.
const RETIRED_OBSERVATION_FIELDS = ['diagnosis', 'differential', 'reviewIn'];

const fail = (message, field) => ({ ok: false, message, field });

const text = (v, max) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;           // wrong type → caller refuses
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? undefined : t;
};

const pick = (v, allowed) => (v === undefined || v === null || v === '' ? null : (allowed.includes(v) ? v : undefined));

const listOf = (v, allowed) => {
  if (v === undefined || v === null || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const clean = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  if (clean.some((x) => !allowed.includes(x))) return undefined;
  return clean.length ? clean.join(',') : null;
};

/** A comma list back into an array (what the API hands the client). */
const splitList = (v) => (v ? String(v).split(',').filter(Boolean) : []);

const mm = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MM) return undefined;
  return Math.round(n * 10) / 10;
};

/**
 * Validate and normalise a finding's identity fields (what it is and where).
 * `partial` = an edit: only the fields sent are checked and returned.
 */
const cleanFinding = (body = {}, { partial = false } = {}) => {
  const out = {};
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(body, k);

  if (has('type')) {
    const t = pick(body.type, FINDING_TYPES);
    if (!t) return fail(`Type must be one of: ${FINDING_TYPES.join(', ')}`, 'type');
    out.type = t;
    // "Other" needs its name; any other type clears it.
    if (t === 'other') {
      const name = text(body.typeOther, 60);
      if (!name) return fail('Name the type of finding (up to 60 characters)', 'typeOther');
      out.typeOther = name;
    } else {
      out.typeOther = null;
    }
  }
  if (has('title')) {
    const t = text(body.title, 120);
    if (!t) return fail('Give the finding a short name (up to 120 characters)', 'title');
    out.title = t;
  }
  if (has('regions')) {
    const regions = Array.isArray(body.regions) ? [...new Set(body.regions)] : null;
    if (!regions || !regions.length) return fail('Mark at least one body region', 'regions');
    if (regions.length > MAX_REGIONS) return fail(`At most ${MAX_REGIONS} regions per finding`, 'regions');
    const unknown = regions.filter((r) => !isRegion(r));
    if (unknown.length) return fail(`Unknown body region: ${unknown.join(', ')}`, 'regions');
    out.regions = regions;
  }
  for (const [k, max] of [['exactSite', 200], ['firstNoticed', 60], ['concern', 1000]]) {
    if (!has(k)) continue;
    const t = text(body[k], max);
    if (t === undefined) return fail(`${k} is too long (up to ${max} characters)`, k);
    out[k] = t;
  }
  return { ok: true, value: out };
};

/**
 * Validate and normalise one day's look at a finding.
 * statusToday is required; a size needs how it was measured; width and depth
 * need a length.
 */
const cleanObservation = (body = {}) => {
  const out = {};
  const statusToday = pick(body.statusToday, STATUS_TODAY);
  if (!statusToday) return fail(`Status today must be one of: ${STATUS_TODAY.join(', ')}`, 'statusToday');
  out.statusToday = statusToday;

  for (const k of ['lengthMm', 'widthMm', 'depthMm']) {
    const v = mm(body[k]);
    if (v === undefined) return fail(`Sizes are millimetres between 0 and ${MAX_MM}`, k);
    out[k] = v;
  }
  if ((out.widthMm || out.depthMm) && !out.lengthMm) return fail('Give the length before width or depth', 'lengthMm');
  const measuredBy = pick(body.measuredBy, MEASURED_BY);
  if (measuredBy === undefined) return fail(`Measured by must be one of: ${MEASURED_BY.join(', ')}`, 'measuredBy');
  if (out.lengthMm && !measuredBy) return fail('Say how the size was measured (ruler, dermatoscope or estimated)', 'measuredBy');
  out.measuredBy = out.lengthMm ? measuredBy : null;

  // The size range when there are several lesions (9 Oct 2026).
  for (const k of ['sizeMinMm', 'sizeMaxMm']) {
    const v = mm(body[k]);
    if (v === undefined) return fail(`Sizes are millimetres between 0 and ${MAX_MM}`, k);
    out[k] = v;
  }
  if (out.sizeMinMm && out.sizeMaxMm && out.sizeMinMm > out.sizeMaxMm) return fail('The smallest size is larger than the largest', 'sizeMinMm');

  // Choice fields take a fixed word or the doctor's own typed word ("Other…",
  // 9 Oct 2026) — utils/dermExam is the one rule.
  for (const k of ['plan']) {
    const v = exam.cleanOne(k, body[k]);
    if (v === undefined) return fail(`${k}: choose from the list or type a word under Other (up to ${exam.MAX_TERM} characters, no commas)`, k);
    out[k] = v;
  }
  for (const k of ['morphology', 'colours', 'symptoms']) {
    const v = exam.cleanMany(k, body[k]);
    if (v === undefined) return fail(`${k}: choose from the list or type a word under Other (up to ${exam.MAX_TERM} characters, no commas)`, k);
    out[k] = v;
  }
  const structured = exam.cleanLookExam(body);
  if (!structured.ok) return structured;
  Object.assign(out, structured.value);

  for (const [k, max] of [['description', 2000], ['diagnosis', 200], ['differential', 300], ['planNote', 2000], ['reviewIn', 60]]) {
    if (RETIRED_OBSERVATION_FIELDS.includes(k) && !Object.prototype.hasOwnProperty.call(body, k)) continue;
    const t = text(body[k], max);
    if (t === undefined) return fail(`${k} is too long (up to ${max} characters)`, k);
    out[k] = t;
  }
  return { ok: true, value: out };
};

/** "#007" — the number a finding is known by in notes and letters. */
const formatNumber = (n) => `#${String(n).padStart(3, '0')}`;

/**
 * Labels for a patient's findings across a merged family (D4). Numbers are
 * per patient record, so after two files merge both may hold a #001: the
 * earliest keeps "#001", later ones read "#001-B", "#001-C". Nothing is ever
 * renumbered — a number already written in a letter keeps meaning one finding.
 *
 * @param {{id:number, number:number, createdAt:Date|string}[]} findings
 * @returns {Map<number,string>} finding id → label
 */
const numberLabels = (findings) => {
  const byNumber = new Map();
  for (const f of findings) {
    if (!byNumber.has(f.number)) byNumber.set(f.number, []);
    byNumber.get(f.number).push(f);
  }
  const labels = new Map();
  for (const [n, group] of byNumber) {
    group.sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || (a.id - b.id));
    group.forEach((f, i) => labels.set(f.id, i === 0 ? formatNumber(n) : `${formatNumber(n)}-${String.fromCharCode(65 + i)}`));
  }
  return labels;
};

/** The finding's lifecycle after a day's look: resolved closes it, anything else (incl. recurrence) keeps / reopens it. */
const findingStatusAfter = (statusToday) => (statusToday === 'resolved' ? 'resolved' : 'active');

/**
 * Who may change a saved observation, and how (D7).
 *   'edit'   — its author, on the same clinic day: changed in place, no reason.
 *   'amend'  — anyone who may record, any later day (or someone else today):
 *              a reason is required and the change is kept in DermEdits.
 */
const changeMode = (observation, userId, today) =>
  (observation.doctorId === userId && observation.visitDate === today ? 'edit' : 'amend');

/** { field: [before, after] } for every listed field that changed. Empty object = nothing changed. */
const diff = (before, after, fields) => {
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(after, f)) continue;
    const a = before[f] === undefined ? null : before[f];
    const b = after[f] === undefined ? null : after[f];
    const same = (a === null && b === null) || String(a) === String(b);
    if (!same) out[f] = [a, b];
  }
  return out;
};

module.exports = {
  FINDING_TYPES, STATUS_TODAY, MORPHOLOGY, BORDERS, SURFACES, COLOURS, SYMPTOMS, PLANS, MEASURED_BY,
  OBSERVATION_FIELDS, FINDING_FIELDS, RETIRED_OBSERVATION_FIELDS, MAX_MM,
  cleanFinding, cleanObservation, splitList, formatNumber, numberLabels, findingStatusAfter, changeMode, diff,
};
