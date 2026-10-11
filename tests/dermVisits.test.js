// Dermatology Phase 4 (7 Oct 2026) — skin visits for Visit History, the
// "All skin visits" grid and the generated note. Pure; no database.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const V = require('../utils/dermVisits');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const F = (id, extra = {}) => ({
  id, label: `#00${id}`, title: `Finding ${id}`, type: 'lesion', regionLabels: ['Left cheek'],
  exactSite: null, concern: null, status: 'active', createdDay: '2026-03-12', ...extra,
});
let nextId = 1;
const O = (findingId, visitDate, extra = {}) => ({
  id: nextId++, findingId, visitDate, statusToday: 'stable', lengthMm: null, widthMm: null, depthMm: null,
  measuredBy: null, morphology: null, border: null, surface: null, colours: [], symptoms: [],
  description: null, diagnosis: null, differential: null, plan: null, planNote: null, reviewIn: null,
  doctorName: 'Dr Kamau', ...extra,
});

describe('which days are skin visits', () => {
  test('a look, a procedure or a photo makes a day; newest day first', () => {
    const r = V.buildSkinVisits({
      findings: [F(1)],
      observations: [O(1, '2026-03-12', { statusToday: 'new' })],
      procedures: [{ id: 1, procedureDate: '2026-06-03', name: 'Cryotherapy', findings: [{ id: 1, label: '#001' }], performedByName: 'Dr Kamau' }],
      photos: [{ id: 5, findingId: 1, visitDate: '2026-09-02', photoType: 'close_up', sensitive: false }],
    });
    assert.deepEqual(r.days.map((d) => d.date), ['2026-09-02', '2026-06-03', '2026-03-12']);
    assert.deepEqual(r.grid.dates, ['2026-03-12', '2026-06-03', '2026-09-02']);
  });

  test('looks at findings that are not in the list (entered in error) are ignored', () => {
    const r = V.buildSkinVisits({ findings: [F(1)], observations: [O(99, '2026-05-01')] });
    assert.equal(r.days.length, 0);
  });
});

describe('a day reads as it was recorded', () => {
  const findings = [F(1), F(2), F(3, { createdDay: '2026-09-02' }), F(4, { status: 'resolved' })];
  const observations = [
    O(1, '2026-03-12', { statusToday: 'new', lengthMm: 5, widthMm: 4 }),
    O(1, '2026-06-03', { statusToday: 'stable' }),
    O(1, '2026-09-02', { statusToday: 'worsened', lengthMm: 7, widthMm: 6, measuredBy: 'ruler' }),
    O(2, '2026-03-12', { statusToday: 'new' }),
    O(4, '2026-03-12', { statusToday: 'new' }),
    O(4, '2026-06-03', { statusToday: 'resolved' }),
    O(3, '2026-09-02', { statusToday: 'new' }),
  ];
  const r = V.buildSkinVisits({ findings, observations });
  const day = (d) => r.days.find((x) => x.date === d);

  test('the size before is the last earlier TYPED size, not the last look', () => {
    const e = day('2026-09-02').entries.find((x) => x.finding.id === 1);
    assert.equal(e.size, '7 × 6 mm');
    assert.deepEqual(e.previous, { visitDate: '2026-03-12', size: '5 × 4 mm', lengthMm: 5, widthMm: 4 });
  });

  test('later looks never change an earlier day', () => {
    const e = day('2026-03-12').entries.find((x) => x.finding.id === 1);
    assert.equal(e.look.statusToday, 'new');
    assert.equal(e.size, '5 × 4 mm');
    assert.equal(e.previous, null);
  });

  test('not examined = existed that day, not looked at; not created later; not resolved before', () => {
    assert.deepEqual(day('2026-06-03').notExamined.map((f) => f.id), [2]);       // #3 did not exist yet
    assert.deepEqual(day('2026-09-02').notExamined.map((f) => f.id), [2]);       // #4 resolved on 3 Jun
  });

  test('a finding that resolves ON a day is examined that day, and gone after', () => {
    assert.ok(day('2026-06-03').entries.some((e) => e.finding.id === 4 && e.look.statusToday === 'resolved'));
  });

  test('grid: status + size, "not examined", blank before it existed and after it resolved', () => {
    const row = (id) => r.grid.rows.find((x) => x.finding.id === id).cells;
    assert.deepEqual(row(1)['2026-03-12'], { status: 'new', size: '5 × 4 mm' });
    assert.deepEqual(row(1)['2026-06-03'], { status: 'stable', size: '' });
    assert.equal(row(2)['2026-06-03'], 'not_examined');
    assert.equal(row(3)['2026-03-12'], null);
    assert.equal(row(4)['2026-09-02'], null);
  });

  test('doctors of the day come from its looks and procedures', () => {
    assert.deepEqual(day('2026-09-02').doctors, ['Dr Kamau']);
  });
});

describe('corrections and photos on a day', () => {
  const o = O(1, '2026-09-02', { lengthMm: 5, widthMm: 5 });
  const r = V.buildSkinVisits({
    findings: [F(1, { regionLabels: ['Groin and genitalia'] })],
    observations: [o],
    edits: [
      { entityId: o.id, action: 'amend', changes: { widthMm: [4, 5] }, reason: 'Transcription error', editedByName: 'Dr Ebrahim', createdAt: '2026-10-07T08:00:00Z' },
      { entityId: o.id, action: 'entered_in_error', changes: {}, reason: 'x', createdAt: '2026-10-07T09:00:00Z' },
    ],
    photos: [{ id: 9, findingId: 1, visitDate: '2026-09-02', photoType: 'close_up', sensitive: true }],
  });
  const e = r.days[0].entries[0];

  test('each amendment shows before → after, who, why (the original stays readable)', () => {
    assert.equal(e.amendments.length, 1);
    assert.deepEqual(e.amendments[0].changes, [{ field: 'widthMm', label: 'Width (mm)', before: 4, after: 5 }]);
    assert.equal(e.amendments[0].by, 'Dr Ebrahim');
    assert.equal(e.amendments[0].reason, 'Transcription error');
  });

  test('photos: counted for everyone, listed only withPhotos', () => {
    assert.equal(e.photoCount, 1);
    assert.deepEqual(e.photos, []);
    const r2 = V.buildSkinVisits({
      findings: [F(1)], observations: [O(1, '2026-09-02')], withPhotos: true,
      photos: [{ id: 9, findingId: 1, visitDate: '2026-09-02', photoType: 'close_up', sensitive: true }],
    });
    assert.deepEqual(r2.days[0].entries[0].photos, [{ id: 9, photoType: 'close_up', sensitive: true, marker: null }]);
  });
});

describe('the generated note', () => {
  const findings = [
    F(1, { title: 'Pigmented papule' }),
    F(2, { title: 'Melanocytic naevus', regionLabels: ['Right forearm'] }),
    F(4, { title: 'Neuropathic ulcer', regionLabels: ['Left sole'], createdDay: '2026-10-07', concern: 'Painless sore under the big toe' }),
  ];
  const observations = [
    O(1, '2026-09-02', { lengthMm: 5, widthMm: 4 }),
    O(1, '2026-10-07', {
      statusToday: 'worsened', lengthMm: 7, widthMm: 6, measuredBy: 'ruler', morphology: 'papule',
      colours: ['brown', 'variegated'], border: 'irregular', surface: 'smooth', symptoms: ['itch'],
      diagnosis: 'Atypical melanocytic lesion', differential: 'early melanoma', plan: 'biopsy',
      planNote: '4 mm punch biopsy taken.', reviewIn: 'When histology is back', doctorName: 'Dr Ebrahim',
    }),
    O(4, '2026-10-07', { statusToday: 'new', lengthMm: 14, widthMm: 9, depthMm: 2 }),
    O(2, '2026-09-02'),
  ];
  const r = V.buildSkinVisits({
    findings, observations,
    procedures: [{ id: 1, procedureDate: '2026-10-07', name: 'Punch biopsy', details: '4 mm, 1 suture.', findings: [{ id: 1, label: '#001' }], performedByName: 'Dr Ebrahim' }],
    photos: [{ id: 3, findingId: 1, visitDate: '2026-10-07', photoType: 'close_up', sensitive: false }],
    histology: [{ id: 1, findingId: 1, visitDate: '2026-10-07', specimenNumber: 'HP-2026-001', kind: 'histology', specimenLabel: 'Punch biopsy', status: 'awaiting' }],
  });
  const note = r.days[0].note;

  test('opens with the day', () => assert.match(note, /^Skin examination, 7 Oct 2026\./));
  test('each finding under Emu\'s headings: location, morphology with size vs before, symptoms, plan', () => {
    assert.match(note, /#001 Pigmented papule — worsened\.\nPrimary lesion\(s\): location left cheek\.\nMorphology: type papule; size 7 × 6 mm, ruler \(was 5 × 4 mm on 2 Sep 2026\); border irregular; colour brown, variegated; surface smooth\.\nSymptoms: itch\. Plan: Biopsy — 4 mm punch biopsy taken\./);
    assert.match(note, /Impression: Atypical melanocytic lesion; differential early melanoma\.\nReview: when histology is back\.\nHistology requested \(HP-2026-001, punch biopsy\)\./);
  });
  test('a first look carries its concern and plain size', () => {
    assert.match(note, /#004 Neuropathic ulcer — new\.\nConcern: Painless sore under the big toe\.\nPrimary lesion\(s\): location left sole\.\nMorphology: size 14 × 9 × 2 mm\./);
  });
  test('procedures, not examined, photography written from the photos', () => {
    assert.match(note, /Procedures: Punch biopsy \(#001\) — 4 mm, 1 suture\./);
    assert.match(note, /Not examined today: #002 melanocytic naevus \(right forearm\)\./);
    assert.match(note, /Photography: clinical photos taken: yes \(1\) — views: #001 left cheek; dermoscopic images taken: no\./);
  });
  test('a finding examined is never also listed as not examined', () => {
    assert.doesNotMatch(note, /Not examined today:.*#001/);
  });
});

describe('structured examination and today\'s whole-skin exam (9 Oct 2026)', () => {
  const r = V.buildSkinVisits({
    findings: [F(1, { title: 'Annular rash', regionLabels: ['Left forearm (front)', 'Left hand (back)'], createdDay: '2026-10-09' })],
    observations: [O(1, '2026-10-09', {
      statusToday: 'new', lengthMm: 22, widthMm: 18, measuredBy: 'ruler', sizeMinMm: 5, sizeMaxMm: 22,
      distribution: 'regional', symmetry: 'asymmetric', pattern: ['photo_exposed', 'Koebnerised'], configuration: ['annular'],
      morphology: ['plaque'], shape: 'round', border: ['well_defined', 'raised'], colours: ['erythematous'], surface: ['scaly'], texture: 'firm',
      scale: 'fine', erosion: 'none', ulceration: 'present', ulcerBase: 'granulating', lesionCount: 8, bsaPercent: 2,
      dermoscopy: true, dsVascular: ['dotted'], dsBlueWhite: 'none', symptoms: ['itch'], plan: 'treat',
    })],
    skinExams: [{ visitDate: '2026-10-09', doctorName: 'Dr Ebrahim', hairExamined: true, scalp: 'mild scaling', hairDensity: 'decreased',
      hairDensityPattern: ['patchy'], pullTest: 'positive', pullTestSite: 'vertex', pullTestCount: 7, exclamationHairs: 'present',
      nailsExamined: false, nodesExamined: false, mucosaExamined: true, oral: 'normal' }],
    photos: [
      { id: 1, findingId: 1, visitDate: '2026-10-09', photoType: 'overview' },
      { id: 2, findingId: 1, visitDate: '2026-10-09', photoType: 'dermoscopy' },
    ],
  });
  const note = r.days[0].note;
  test('every heading the doctor filled, in order', () => {
    assert.match(note, /Primary lesion\(s\): location left forearm \(front\), left hand \(back\); distribution regional, asymmetric; pattern photo-exposed, Koebnerised; configuration annular\./);
    assert.match(note, /Morphology: type plaque; size 22 × 18 mm, ruler, range 5–22 mm; shape round; border well-defined, raised; colour erythematous; surface scaly; texture firm\./);
    assert.match(note, /Secondary changes: scale fine; erosion none; ulceration present, base granulating\./);
    assert.match(note, /Quantification: number of lesions 8; 2 % BSA\./);
    assert.match(note, /Dermoscopy: blue-white structures none; vascular pattern dotted vessels\./);
  });
  test('the whole-skin exam prints only the parts examined', () => {
    assert.match(note, /Hair: scalp mild scaling; density decreased \(patchy\); pull test positive \(vertex, 7 hairs\); exclamation-point hairs present\.\nMucosa: oral normal\./);
    assert.doesNotMatch(note, /Nails:|Lymph nodes:/);
  });
  test('photography counts clinical and dermoscopic photos separately', () => {
    assert.match(note, /Photography: clinical photos taken: yes \(1\) — views: #001 left forearm \(front\), left hand \(back\); dermoscopic images taken: yes \(1\)/);
  });
  test('a day with only a whole-skin exam is still a skin visit', () => {
    const only = V.buildSkinVisits({ skinExams: [{ visitDate: '2026-10-09', mucosaExamined: true, oral: 'normal' }] });
    assert.equal(only.days.length, 1);
    assert.match(only.days[0].note, /Mucosa: oral normal\./);
  });
});

describe('guard-rails', () => {
  test('the visits route is read-gated like the board and logged', () => {
    const routes = read('routes/derm.js');
    assert.match(routes, /router\.get\('\/patients\/:uhid\/visits', authorize\('doctor', 'nurse', 'admin', PERMISSIONS\.CLINICAL_VIEW\), logPatientAccess\('dermatology'\), derm\.skinVisits\)/);
  });
  test('the worklist is declared before /:id and is read-gated', () => {
    const routes = read('routes/histology.js');
    const w = routes.indexOf("router.get('/worklist'");
    const one = routes.indexOf("router.get('/:id'");
    assert.ok(w > 0 && w < one);
    assert.match(routes, /router\.get\('\/worklist', authorize\('doctor', 'nurse', 'admin', PERMISSIONS\.CLINICAL_VIEW\), histology\.worklist\)/);
  });
  test('the visits controller reads merge-aware and lists photos only for doctor / derm.record', () => {
    const c = read('controllers/dermController.js');
    const fn = c.slice(c.indexOf('const skinVisits'), c.indexOf('module.exports'));
    assert.match(fn, /resolvePatient\(req\.params\.uhid\)/);
    assert.match(fn, /PatientId: \{ \[Op\.in\]: family\.patientIds \}/);
    assert.match(fn, /passesGate\(req\.user, \['doctor', PERMISSIONS\.DERM_RECORD\]\)/);
  });
});
