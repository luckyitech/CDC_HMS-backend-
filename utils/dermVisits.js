// =====================================================================
// Dermatology — skin visits for Visit History and the generated note
// (Phase 4, 7 Oct 2026; decisions D12, D13, V1–V6). Pure: no database, so
// every rule is unit-tested in tests/dermVisits.test.js.
//
// A "skin visit" is a clinic day on which anything was recorded on the skin
// record: a look at a finding (observation), a procedure, or a photo.
//
// How a day reads (D13):
//   - each finding examined that day, with THAT day's status, size and
//     description (its own observation row — later visits never change it),
//     the last earlier typed size for comparison, and any later corrections
//     to that day's entry listed underneath (V5: before → after, who, why);
//   - the findings that existed but were not examined that day (D6) — not
//     ones created later, and not ones already resolved before the day;
//   - procedures and photos of the day.
//
// The generated note (D12) is plain templating from those same structured
// entries, never AI, and is not stored: the entries are the record.
// =====================================================================

const dermExam = require('./dermExam');

// Labels a doctor reads. Mirrors cdc-hms/src/components/doctor/derm/dermFormat.js.
const LABEL = {
  type: { lesion: 'Lesion', rash: 'Rash', ulcer: 'Ulcer', scar: 'Scar', pigmentation: 'Pigmentation', hair_loss: 'Hair loss', nail: 'Nail', other: 'Other' },
  status: { new: 'new', improved: 'improved', stable: 'stable', worsened: 'worsened', resolved: 'resolved', recurrence: 'recurrence' },
  border: { regular: 'regular', irregular: 'irregular', well_defined: 'well-defined', ill_defined: 'ill-defined' },
  colour: {
    skin_coloured: 'skin-coloured', erythematous: 'erythematous', brown: 'brown', black: 'black', blue_grey: 'blue-grey',
    hypopigmented: 'hypopigmented', hyperpigmented: 'hyperpigmented', violaceous: 'violaceous', yellow: 'yellow', variegated: 'variegated',
  },
  plan: { monitor: 'monitor', treat: 'treat', biopsy: 'biopsy', excise: 'excise', refer: 'refer', discharge: 'discharge' },
  measuredBy: { ruler: 'ruler', dermatoscope: 'dermatoscope scale', estimated: 'estimated' },
  field: {
    statusToday: 'Status', lengthMm: 'Length (mm)', widthMm: 'Width (mm)', depthMm: 'Depth (mm)', measuredBy: 'Measured by',
    morphology: 'Morphology', border: 'Border', surface: 'Surface', colours: 'Colour', symptoms: 'Symptoms',
    description: 'Description', diagnosis: 'Diagnosis', differential: 'Differential', plan: 'Plan', planNote: 'Plan note',
    reviewIn: 'Review in', typeOther: 'Type (other)',
  },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-09-02' → '2 Sep 2026' (clinic DATEONLY strings; no time zone involved). */
const fmtDay = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

const trimNum = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
};

/** "7 × 6 mm", "7 × 6 × 2 mm", "7 mm", or '' when no size was typed. */
const sizeText = (o) => {
  if (!o || o.lengthMm === null || o.lengthMm === undefined) return '';
  const parts = [o.lengthMm, o.widthMm, o.depthMm].filter((v) => v !== null && v !== undefined && v !== '');
  return `${parts.map(trimNum).join(' × ')} mm`;
};

/** "7 × 6 mm, ruler (was 5 × 4 mm on 2 Sep 2026)" — today's size with how, and the last earlier size. */
const sizeLine = (o, earlier) => {
  const now = sizeText(o);
  if (!now) return '';
  const how = o.measuredBy ? `, ${LABEL.measuredBy[o.measuredBy] || o.measuredBy}` : '';
  const was = earlier && sizeText(earlier) ? ` (was ${sizeText(earlier)} on ${fmtDay(earlier.visitDate)})` : '';
  return `${now}${how}${was}`;
};

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const listify = (v) => (Array.isArray(v) ? v : (v ? String(v).split(',').filter(Boolean) : []));

/** "left cheek" / "scalp, left elbow" — the finding's regions, read in a sentence. */
const whereText = (f) => {
  const regions = (f.regionLabels || []).map(lowerFirst).join(', ');
  return [regions, f.exactSite].filter(Boolean).join(' — ');
};

/** One sentence of examination detail: "Brown, variegated papule, irregular border, smooth surface; itch". */
const examText = (o) => {
  const head = [dermExam.phrase('colours', o.colours), dermExam.phrase('morphology', o.morphology)].filter(Boolean).join(' ');
  const bits = [];
  if (head) bits.push(upperFirst(head));
  if (dermExam.listOf(o.border).length) bits.push(`${dermExam.phrase('border', o.border)} border`);
  if (dermExam.listOf(o.surface).length) bits.push(`${dermExam.phrase('surface', o.surface)} surface`);
  let s = bits.join(', ');
  const sym = dermExam.listOf(o.symptoms).filter((x) => x !== 'none');
  if (sym.length) s += `${s ? '; ' : ''}${dermExam.phrase('symptoms', sym)}`;
  return s;
};

/**
 * Was this finding on the patient on `date` — i.e. recorded by then and not
 * already resolved before it? `obsByDate` is that finding's active looks,
 * date → look. A look ON `date` always counts (it was examined).
 */
const existedOn = (finding, obsList, date) => {
  if (!finding.createdDay || finding.createdDay > date) return false;
  const before = obsList.filter((o) => o.visitDate < date);
  if (!before.length) return true;
  const last = before.reduce((a, b) => (b.visitDate > a.visitDate ? b : a));
  return last.statusToday !== 'resolved';
};

/** Corrections to one look, newest last: [{ when, by, reason, changes: [{ field, label, before, after }] }]. */
const amendmentsFor = (edits) => edits
  .filter((e) => e.action === 'amend')
  .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  .map((e) => ({
    when: e.createdAt,
    by: e.editedByName || null,
    reason: e.reason,
    changes: Object.entries(e.changes || {}).map(([field, pair]) => ({
      field,
      label: LABEL.field[field] || field,
      before: Array.isArray(pair) ? pair[0] : null,
      after: Array.isArray(pair) ? pair[1] : null,
    })),
  }));

/**
 * Build every skin visit for one patient.
 *
 * @param {object} input
 *   findings     [{ id, label, title, type, regions[] (ids), regionLabels[], exactSite, concern, status, createdDay }]
 *                — entered-in-error findings must already be left out
 *   observations [{ id, findingId, visitDate, statusToday, lengthMm, widthMm, depthMm, measuredBy,
 *                   morphology, border, surface, colours[], symptoms[], description, diagnosis,
 *                   differential, plan, planNote, reviewIn, doctorName, amendedAt }] — active only
 *   edits        [{ entityId (observation id), action, changes, reason, editedByName, createdAt }]
 *   procedures   [{ id, procedureDate, name, details, findings: [{ id, label, title }], performedByName,
 *                   histology }] — active only
 *   photos       [{ id, findingId, visitDate, photoType, sensitive }] — active only
 *   histology    [{ id, findingId, visitDate, specimenNumber, kind, specimenLabel, status }] — skin
 *                requests linked to a finding (only while the Histology module is on), else []
 *   skinExams    [{ visitDate, …formatted DermSkinExam, doctorName }] — today's whole-skin exams (9 Oct 2026)
 *   withPhotos   true → each entry lists its photos' metadata; false → counts only (V4: nurses)
 * @returns {{ days: object[], grid: { dates: string[], rows: object[] } }}  days newest first
 */
const buildSkinVisits = ({
  findings = [], observations = [], edits = [], procedures = [], photos = [], histology = [], skinExams = [], withPhotos = false,
}) => {
  const findingById = new Map(findings.map((f) => [f.id, f]));
  const obs = observations.filter((o) => findingById.has(o.findingId));
  const obsByFinding = new Map(findings.map((f) => [f.id, []]));
  for (const o of obs) obsByFinding.get(o.findingId).push(o);
  const editsByObs = new Map();
  for (const e of edits) {
    if (!editsByObs.has(e.entityId)) editsByObs.set(e.entityId, []);
    editsByObs.get(e.entityId).push(e);
  }
  const knownPhotos = photos.filter((p) => findingById.has(p.findingId));

  const dates = new Set();
  obs.forEach((o) => dates.add(o.visitDate));
  procedures.forEach((p) => dates.add(p.procedureDate));
  knownPhotos.forEach((p) => dates.add(p.visitDate));
  skinExams.forEach((e) => dates.add(e.visitDate));
  const ordered = [...dates].filter(Boolean).sort();

  const findingRef = (f) => ({
    id: f.id, label: f.label, title: f.title, type: f.type, typeLabel: (f.type === 'other' && f.typeOther) ? f.typeOther : (LABEL.type[f.type] || f.type),
    where: whereText(f), regions: f.regions || [], regionLabels: f.regionLabels || [],
  });

  const days = ordered.map((date) => {
    const todays = obs.filter((o) => o.visitDate === date)
      .sort((a, b) => (findingById.get(a.findingId).label || '').localeCompare(findingById.get(b.findingId).label || ''));
    const entries = todays.map((o) => {
      const f = findingById.get(o.findingId);
      const earlier = (obsByFinding.get(f.id) || [])
        .filter((x) => x.visitDate < date && x.lengthMm !== null && x.lengthMm !== undefined)
        .sort((a, b) => b.visitDate.localeCompare(a.visitDate))[0] || null;
      const dayPhotos = knownPhotos.filter((p) => p.findingId === f.id && p.visitDate === date);
      return {
        finding: findingRef(f),
        isFirstLook: f.createdDay === date,
        concern: f.createdDay === date ? (f.concern || null) : null,
        look: o,
        previous: earlier ? { visitDate: earlier.visitDate, size: sizeText(earlier), lengthMm: earlier.lengthMm, widthMm: earlier.widthMm } : null,
        size: sizeText(o),
        exam: examText(o),
        sections: dermExam.lookSections(o, { where: whereText(f), size: sizeLine(o, earlier) }),
        amendments: amendmentsFor(editsByObs.get(o.id) || []),
        photoCount: dayPhotos.length,
        photos: withPhotos ? dayPhotos.map((p) => ({ id: p.id, photoType: p.photoType, sensitive: !!p.sensitive, marker: p.marker || null })) : [],
        histology: histology.filter((h) => h.findingId === f.id && h.visitDate === date),
      };
    });
    const examinedIds = new Set(todays.map((o) => o.findingId));
    const notExamined = findings
      .filter((f) => !examinedIds.has(f.id) && existedOn(f, obsByFinding.get(f.id) || [], date))
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
      .map(findingRef);
    const dayProcedures = procedures.filter((p) => p.procedureDate === date);
    const dayPhotos = knownPhotos.filter((p) => p.visitDate === date);
    const skinExam = skinExams.find((e) => e.visitDate === date) || null;
    const doctors = [...new Set([
      ...todays.map((o) => o.doctorName),
      ...dayProcedures.map((p) => p.performedByName),
      skinExam ? skinExam.doctorName : null,
    ].filter(Boolean))];
    const day = {
      date,
      doctors,
      entries,
      notExamined,
      procedures: dayProcedures,
      photoCount: dayPhotos.length,
      histology: histology.filter((h) => h.visitDate === date),
      skinExam: skinExam ? { ...skinExam, sections: dermExam.skinExamSections(skinExam) } : null,
      // Photography is written from the photos, never typed (S10).
      photography: dermExam.photographyText(dayPhotos.map((p) => {
        const f = findingById.get(p.findingId);
        return { photoType: p.photoType, view: f ? `${f.label} ${whereText(f)}`.trim() : '' };
      })),
    };
    day.note = skinNote(day);
    return day;
  });

  // "All skin visits" (V6): every finding against every skin visit.
  //   { status, size } examined that day · 'not_examined' existed, not looked at
  //   null before it was first recorded, or after it resolved
  const rows = findings
    .slice()
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
    .map((f) => {
      const list = obsByFinding.get(f.id) || [];
      const cells = {};
      for (const date of ordered) {
        const o = list.find((x) => x.visitDate === date);
        if (o) cells[date] = { status: o.statusToday, size: sizeText(o) };
        else cells[date] = existedOn(f, list, date) ? 'not_examined' : null;
      }
      return { finding: findingRef(f), status: f.status, cells };
    })
    .filter((r) => Object.values(r.cells).some((c) => c !== null));

  return { days: days.reverse(), grid: { dates: ordered, rows } };
};

/**
 * The generated note for one skin visit (D12, V1; headings per Emu, 9 Oct
 * 2026) — plain text built only from that day's structured entries. A section
 * with nothing recorded is left out.
 */
const skinNote = (day) => {
  const blocks = [];
  blocks.push(`Skin examination, ${fmtDay(day.date)}.`);
  for (const e of day.entries) {
    const o = e.look;
    const lines = [`${e.finding.label} ${e.finding.title} — ${LABEL.status[o.statusToday] || o.statusToday}.`];
    if (e.concern) lines.push(`Concern: ${e.concern.trim().replace(/\.?$/, '.')}`);
    const sections = e.sections || dermExam.lookSections(o, { where: e.finding.where, size: e.size });
    for (const s of sections) lines.push(`${s.heading}: ${s.text}.`);
    const sym = dermExam.listOf(o.symptoms).filter((x) => x !== 'none');
    const plan = [o.plan ? upperFirst(lowerFirst(dermExam.labelOf('plan', o.plan))) : null, o.planNote ? o.planNote.trim().replace(/\.$/, '') : null].filter(Boolean).join(' — ');
    const tail = [sym.length ? `Symptoms: ${dermExam.phrase('symptoms', sym)}.` : (dermExam.listOf(o.symptoms).includes('none') ? 'Symptoms: none.' : ''),
      plan ? `Plan: ${plan}.` : ''].filter(Boolean).join(' ');
    if (tail) lines.push(tail);
    if (o.description) lines.push(`Notes: ${o.description.trim().replace(/\.?$/, '.')}`);
    if (o.diagnosis) lines.push(`Impression: ${o.diagnosis}${o.differential ? `; differential ${o.differential}` : ''}.`);
    else if (o.differential) lines.push(`Differential: ${o.differential}.`);
    if (o.reviewIn) lines.push(`Review: ${lowerFirst(o.reviewIn)}.`);
    for (const h of e.histology || []) {
      lines.push(`${h.kind === 'cytology' ? 'Cytology' : 'Histology'} requested (${h.specimenNumber}${h.specimenLabel ? `, ${lowerFirst(h.specimenLabel)}` : ''}).`);
    }
    blocks.push(lines.join('\n'));
  }
  const whole = day.skinExam ? (day.skinExam.sections || dermExam.skinExamSections(day.skinExam)) : [];
  if (whole.length) blocks.push(whole.map((s) => `${s.heading}: ${s.text}.`).join('\n'));
  const rest = [];
  if (day.procedures.length) {
    rest.push(`Procedures: ${day.procedures.map((p) => {
      const on = (p.findings || []).map((f) => f.label).join(', ');
      return `${p.name}${on ? ` (${on})` : ''}${p.details ? ` — ${p.details.trim().replace(/\.$/, '')}` : ''}`;
    }).join('; ')}.`);
  }
  if (day.notExamined.length) {
    rest.push(`Not examined today: ${day.notExamined.map((f) => `${f.label} ${lowerFirst(f.title)}${f.where ? ` (${f.where})` : ''}`).join(', ')}.`);
  }
  if (day.photography) rest.push(`Photography: ${day.photography}.`);
  if (rest.length) blocks.push(rest.join('\n'));
  return blocks.join('\n\n');
};

module.exports = { buildSkinVisits, skinNote, sizeText, sizeLine, examText, existedOn, fmtDay, LABEL };
