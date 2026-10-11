// Dermatology Phase 1 + consultation tool preferences (7 Oct 2026) — pure
// rules and the guard-rails around them. No database.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rules = require('../utils/dermRules');
const { REGION_IDS, isRegion, isSensitiveRegion } = require('../utils/dermRegions');
const { cleanToolPrefs, TOOL_IDS, PREFERENCE_KEYS } = require('../utils/consultationTools');
const { stripJpeg, hasMetadata, isJpeg, cleanMarker } = require('../utils/dermPhotoStorage');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FE = path.join(ROOT, '..', 'frontend', 'cdc-hms', 'src');
const feRead = (rel) => fs.readFileSync(path.join(FE, rel), 'utf8');
const hasFrontend = fs.existsSync(FE);

describe('body regions', () => {
  test('ids are unique and patient-side labelled', () => {
    assert.equal(new Set(REGION_IDS).size, REGION_IDS.length);
    assert.ok(isRegion('f-cheek-l') && !isRegion('f-tail'));
  });
  test('groin and buttocks are sensitive sites', () => {
    for (const id of ['f-groin', 'b-butt-l', 'b-butt-r']) assert.ok(isSensitiveRegion(id), id);
    assert.ok(!isSensitiveRegion('f-forehead'));
  });
  test('the frontend draws exactly the same region ids', () => {
    if (!hasFrontend) return;   // backend-only checkout
    const ids = [...feRead('constants/dermRegions.js').matchAll(/id: '([a-z0-9-]+)'/g)].map((m) => m[1]);
    assert.deepEqual(ids, REGION_IDS);
  });
  test('every figure (female, male, child) draws every region on its own view (8 Oct)', () => {
    if (!hasFrontend) return;
    const src = feRead('constants/dermBodyMaps.js');
    const maps = JSON.parse(src.slice(src.indexOf('DERM_BODY_MAPS = ') + 17, src.lastIndexOf('}') + 1));
    for (const fig of ['female', 'male', 'child']) {
      for (const view of ['front', 'back']) {
        const want = REGION_IDS.filter((id) => id.startsWith(view === 'front' ? 'f-' : 'b-')).sort();
        assert.deepEqual(Object.keys(maps[fig][view].regions).sort(), want, `${fig} ${view}`);
      }
    }
  });
});

describe('a finding', () => {
  test('needs a type, a name and at least one known region', () => {
    assert.equal(rules.cleanFinding({ title: 'x', regions: ['f-abdo'] }).field, 'type');
    assert.equal(rules.cleanFinding({ type: 'lesion', regions: ['f-abdo'] }).field, 'title');
    assert.equal(rules.cleanFinding({ type: 'lesion', title: 'x', regions: [] }).field, 'regions');
    assert.equal(rules.cleanFinding({ type: 'lesion', title: 'x', regions: ['nope'] }).field, 'regions');
    const ok = rules.cleanFinding({ type: 'rash', title: ' Psoriasis ', regions: ['b-elbow-l', 'b-elbow-l', 'b-elbow-r'] });
    assert.ok(ok.ok);
    assert.equal(ok.value.title, 'Psoriasis');
    assert.deepEqual(ok.value.regions, ['b-elbow-l', 'b-elbow-r']);
  });
  test('an edit checks only what was sent', () => {
    const r = rules.cleanFinding({ exactSite: 'Medial canthus' }, { partial: true });
    assert.deepEqual(r, { ok: true, value: { exactSite: 'Medial canthus' } });
  });
});

describe("a day's look", () => {
  test('status is required', () => {
    assert.equal(rules.cleanObservation({}).field, 'statusToday');
  });
  test('a size is typed in mm and says how it was measured', () => {
    assert.equal(rules.cleanObservation({ statusToday: 'new', lengthMm: 5 }).field, 'measuredBy');
    assert.equal(rules.cleanObservation({ statusToday: 'new', widthMm: 5, measuredBy: 'ruler' }).field, 'lengthMm');
    assert.equal(rules.cleanObservation({ statusToday: 'new', lengthMm: -1, measuredBy: 'ruler' }).field, 'lengthMm');
    assert.equal(rules.cleanObservation({ statusToday: 'new', lengthMm: 3000, measuredBy: 'ruler' }).field, 'lengthMm');
    const ok = rules.cleanObservation({ statusToday: 'worsened', lengthMm: '7.04', widthMm: 6, measuredBy: 'ruler' });
    assert.equal(ok.value.lengthMm, 7);
    assert.equal(ok.value.widthMm, 6);
  });
  test('no size → no method stored', () => {
    assert.equal(rules.cleanObservation({ statusToday: 'stable', measuredBy: 'ruler' }).value.measuredBy, null);
  });
  test('multi-choice fields are a comma list of known tokens only', () => {
    assert.equal(rules.cleanObservation({ statusToday: 'new', colours: ['brown', 'variegated', 'brown'] }).value.colours, 'brown,variegated');
    // "Other…" (9 Oct 2026): a typed word is kept as typed; a comma or a word over 40 characters is refused.
    assert.equal(rules.cleanObservation({ statusToday: 'new', colours: ['tartan'] }).value.colours, 'tartan');
    assert.equal(rules.cleanObservation({ statusToday: 'new', colours: ['x'.repeat(41)] }).field, 'colours');
    assert.deepEqual(rules.splitList('brown,variegated'), ['brown', 'variegated']);
    assert.deepEqual(rules.splitList(null), []);
  });
  test('closed lists refuse anything else', () => {
    assert.equal(rules.cleanObservation({ statusToday: 'new', morphology: 'Blob' }).value.morphology, 'Blob');
    assert.equal(rules.cleanObservation({ statusToday: 'new', morphology: '123' }).field, 'morphology', 'a typed word needs a letter');
    assert.equal(rules.cleanObservation({ statusToday: 'new', plan: 'a,b' }).field, 'plan');
  });
});

describe('numbering across a merged family (D4)', () => {
  test('a shared number reads #001 then #001-B, by age; nothing renumbered', () => {
    const labels = rules.numberLabels([
      { id: 10, number: 1, createdAt: '2026-03-12T08:00:00Z' },
      { id: 11, number: 2, createdAt: '2026-03-12T08:05:00Z' },
      { id: 30, number: 1, createdAt: '2026-06-01T08:00:00Z' },
    ]);
    assert.equal(labels.get(10), '#001');
    assert.equal(labels.get(11), '#002');
    assert.equal(labels.get(30), '#001-B');
  });
});

describe('lifecycle and changes', () => {
  test('resolved closes a finding; recurrence (or anything else) keeps it open', () => {
    assert.equal(rules.findingStatusAfter('resolved'), 'resolved');
    assert.equal(rules.findingStatusAfter('recurrence'), 'active');
    assert.equal(rules.findingStatusAfter('stable'), 'active');
  });
  test('only the author, on the same clinic day, edits without a reason', () => {
    const o = { doctorId: 7, visitDate: '2026-10-07' };
    assert.equal(rules.changeMode(o, 7, '2026-10-07'), 'edit');
    assert.equal(rules.changeMode(o, 8, '2026-10-07'), 'amend');
    assert.equal(rules.changeMode(o, 7, '2026-10-08'), 'amend');
  });
  test('diff lists only real changes, numbers compared by value', () => {
    assert.deepEqual(rules.diff({ lengthMm: 5, plan: 'monitor' }, { lengthMm: '5', plan: 'biopsy' }, ['lengthMm', 'plan']), { plan: ['monitor', 'biopsy'] });
    assert.deepEqual(rules.diff({ diagnosis: null }, { diagnosis: null }, ['diagnosis']), {});
  });
});

describe('consultation tools (D16)', () => {
  test('prefs keep only known tool ids; always-open never includes a hidden tool', () => {
    assert.deepEqual(
      cleanToolPrefs({ order: ['dermatology', 'x', 'glp1', 'glp1'], hidden: ['glp1', 'y'], open: ['glp1', 'dermatology'] }),
      { order: ['dermatology', 'glp1'], hidden: ['glp1'], open: ['dermatology'] },
    );
    assert.deepEqual(cleanToolPrefs('nonsense'), { order: [], hidden: [], open: [] });
  });
  test('only listed preference keys can be stored', () => {
    assert.deepEqual(Object.keys(PREFERENCE_KEYS), ['consultation.tools']);
  });
  test('the frontend knows exactly the same tool ids', () => {
    if (!hasFrontend) return;
    const ids = [...feRead('constants/consultationTools.js').matchAll(/\{ id: '([a-z0-9]+)'/g)].map((m) => m[1]);
    assert.deepEqual(ids, TOOL_IDS);
  });
});

// A synthetic JPEG header: SOI, APP0 (JFIF), APP1 (Exif with "GPS"), COM,
// SOF0 640×480, SOS + a few data bytes, EOI. The parser never decodes pixels.
const seg = (marker, body) => { const b = Buffer.from(body); const h = Buffer.from([0xFF, marker, 0, 0]); h.writeUInt16BE(b.length + 2, 2); return Buffer.concat([h, b]); };
const sof = () => { const b = Buffer.alloc(15); b[0] = 8; b.writeUInt16BE(480, 1); b.writeUInt16BE(640, 3); b[5] = 3; return seg(0xC0, b); };
const FAKE_JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8]), seg(0xE0, 'JFIF\0\x01\x01'), seg(0xE1, 'Exif\0\0GPS-1.29,36.82'), seg(0xFE, 'camera note'),
  sof(), Buffer.from([0xFF, 0xDA, 0x00, 0x04, 0x01, 0x02, 0x11, 0x22, 0x33]), Buffer.from([0xFF, 0xD9]),
]);

describe('skin photos (Phase 2)', () => {
  test('metadata is stripped and the pixel size read', () => {
    assert.ok(isJpeg(FAKE_JPEG) && hasMetadata(FAKE_JPEG));
    const { buffer, width, height } = stripJpeg(FAKE_JPEG);
    assert.equal(width, 640); assert.equal(height, 480);
    assert.ok(!hasMetadata(buffer));
    assert.ok(!buffer.includes(Buffer.from('GPS')) && !buffer.includes(Buffer.from('camera note')));
    assert.ok(buffer.includes(Buffer.from('JFIF')), 'JFIF header kept');
    assert.equal(buffer[buffer.length - 1], 0xD9);
  });
  test('anything that is not a JPEG is refused', () => {
    assert.throws(() => stripJpeg(Buffer.from('\x89PNG\r\n')), /NOT_JPEG/);
    assert.throws(() => stripJpeg(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x7F, 0xFF])])), /BAD_JPEG/);
  });
  test('the marker is an ellipse in 0…1 picture coordinates, never a size', () => {
    assert.deepEqual(cleanMarker({ cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.2 }), { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.2 });
    assert.equal(cleanMarker(null), null);
    assert.equal(cleanMarker({ cx: 2, cy: 0.5, rx: 0.1, ry: 0.1 }), undefined);
    assert.equal(cleanMarker('{bad'), undefined);
    assert.equal(cleanMarker({ cx: 0.5, cy: 0.5, rx: 0, ry: 0.1 }), undefined);
  });
  test('photos are stored only under private/, never the static uploads folder', () => {
    const src = read('utils/dermPhotoStorage.js');
    assert.match(src, /'private', 'derm-photos'/);
    assert.doesNotMatch(read('app.js'), /derm-photos/);
  });
  test('the picture routes are for doctors / derm.record, not clinical.view', () => {
    const src = read('routes/derm.js');
    for (const m of src.matchAll(/router\.\w+\('(\/patients\/:uhid\/photos|\/photos\/:id\/file)'[^\n]*/g)) {
      assert.match(m[0], /authorize\('doctor', PERMISSIONS\.DERM_RECORD\)/, m[0]);
      assert.doesNotMatch(m[0], /CLINICAL_VIEW|'nurse'|'admin'/, m[0]);
    }
  });
  test('no photo without consent; every opening is logged', () => {
    const src = read('controllers/dermPhotoController.js');
    assert.match(src, /NO_CONSENT/);
    assert.match(src, /DermPhotoView\.create/);
    assert.doesNotMatch(src, /DermPhoto\.destroy|fs\.promises\.unlink\(path\.join\(dir/);
  });
});

describe('guard-rails', () => {
  test('every dermatology route sits behind login and the module switch', () => {
    const src = read('routes/derm.js');
    assert.match(src, /router\.use\(authenticate, requireModule\('dermatology'\)\)/);
    assert.match(read('services/clinicModules.js'), /key: 'dermatology'/);
  });
  test('writes are doctor or derm.record — never the admin.access bypass', () => {
    const src = read('routes/derm.js');
    for (const m of src.matchAll(/router\.(post|put|patch|delete)\([^\n]*authorize\(([^)]*)\)/g)) {
      assert.doesNotMatch(m[2], /'admin'/, m[0]);
      assert.match(m[2], /DERM_RECORD/, m[0]);
    }
  });
  test('nothing in dermatology hard-deletes a clinical row', () => {
    const src = read('controllers/dermController.js');
    assert.doesNotMatch(src, /DermFinding\.destroy|DermObservation\.destroy|DermEdit\.destroy|\.destroy\(\{ where: \{ id/);
  });
  test('attribution comes from the token', () => {
    const src = read('controllers/dermController.js');
    assert.doesNotMatch(src, /doctorId:\s*req\.body|createdById:\s*req\.body|editedById:\s*req\.body/);
  });
  test('the migration refuses a lossy down', () => {
    const src = read('migrations/20260928000021-dermatology-and-user-preferences.js');
    assert.match(src, /down refused/);
  });
});

// ---------------------------------------------------------------------
// Click-through changes (8 Oct 2026, migration …024)
// ---------------------------------------------------------------------
describe('click-through changes (8 Oct)', () => {
  const R = require('../utils/dermRules');
  const base = { type: 'lesion', title: 'Papule', regions: ['face_l_cheek'] };
  const region = require('../utils/dermRegions').DERM_REGIONS[0].id;

  test('"Other" needs its typed name; any other type clears it', () => {
    const miss = R.cleanFinding({ ...base, regions: [region], type: 'other' });
    assert.equal(miss.ok, false); assert.equal(miss.field, 'typeOther');
    const ok = R.cleanFinding({ ...base, regions: [region], type: 'other', typeOther: '  Keloid ' });
    assert.equal(ok.ok, true); assert.equal(ok.value.typeOther, 'Keloid');
    const cleared = R.cleanFinding({ ...base, regions: [region], type: 'scar', typeOther: 'Keloid' });
    assert.equal(cleared.value.typeOther, null);
    assert.equal(R.cleanFinding({ ...base, regions: [region], type: 'other', typeOther: 'x'.repeat(61) }).ok, false);
    assert.ok(R.FINDING_FIELDS.includes('typeOther'), 'a changed name is kept in the amendment trail');
  });

  test('morphology is a list of known tokens', () => {
    const o = R.cleanObservation({ statusToday: 'new', morphology: ['papule', 'vesicle', 'papule'] });
    assert.equal(o.ok, true); assert.equal(o.value.morphology, 'papule,vesicle');
    assert.equal(R.cleanObservation({ statusToday: 'new', morphology: 'papule' }).value.morphology, 'papule');
    assert.equal(R.cleanObservation({ statusToday: 'new', morphology: ['papule', 'Blob'] }).value.morphology, 'papule,Blob');
  });

  test('retired fields (diagnosis, differential, review) are left alone unless sent', () => {
    const o = R.cleanObservation({ statusToday: 'stable' });
    for (const k of R.RETIRED_OBSERVATION_FIELDS) assert.equal(Object.prototype.hasOwnProperty.call(o.value, k), false, k);
    assert.equal(R.cleanObservation({ statusToday: 'stable', differential: 'Eczema' }).value.differential, 'Eczema');
  });

  test('the vocabulary route is read-gated behind login and the module switch', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/derm.js'), 'utf8');
    assert.match(src, /router\.get\('\/vocabulary', authorize\('doctor', 'nurse', 'admin', PERMISSIONS\.CLINICAL_VIEW\), derm\.vocabulary\)/);
  });

  test('the migration refuses a lossy down', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../migrations/20260928000024-derm-type-other-and-morphology-list.js'), 'utf8');
    assert.match(src, /down refused/); assert.match(src, /describeTable/);
  });
});

describe('photos attached to areas (8 Oct, migration …026)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../controllers/dermPhotoController.js'), 'utf8');
  test('every area must be one of the finding\'s own regions; none = overview', () => {
    assert.match(src, /areas\.value\.some\(\(r\) => !findingRegions\.includes\(r\)\)/);
  });
  test('blurring follows the photo\'s own areas when it has any', () => {
    assert.match(src, /const sensitive = areas\.length \? areas\.some\(\(r\) => isSensitiveRegion\(r\)\)/);
  });
  test('the photo and its areas are written in one transaction', () => {
    assert.match(src, /DermPhotoRegion\.bulkCreate\([^)]*\)[^;]*\{ transaction \}/);
  });
  test('the migration guards, folds in the draft column and refuses a lossy down', () => {
    const m = require('fs').readFileSync(require('path').join(__dirname, '../migrations/20260928000026-derm-photo-regions.js'), 'utf8');
    assert.match(m, /showAllTables/); assert.match(m, /cols\.region/); assert.match(m, /down refused/);
  });
});

describe('Emu 10 Oct 2026 — every area, child figure under 4, bin on saved findings', () => {
  test('a finding may cover every area on the map (44), not more', () => {
    assert.equal(REGION_IDS.length, 44);
    const all = rules.cleanFinding({ type: 'rash', title: 'Generalised eruption', regions: [...REGION_IDS] });
    assert.equal(all.ok, true);
    assert.equal(all.value.regions.length, 44);
  });
  test('the child figure is for under-4s; the bin retires or deletes, never hard-deletes', { skip: !hasFrontend }, () => {
    assert.match(feRead('components/doctor/derm/dermFigure.js'), /CHILD_UNDER_YEARS = 4;/);
    const bin = feRead('components/doctor/derm/DermBinButton.jsx');
    assert.match(bin, /findingInError/);
    assert.match(bin, /statusToday: 'resolved'/);
    assert.doesNotMatch(bin, /destroy|\.delete\(/);
    assert.match(feRead('components/doctor/derm/DermSiteExam.jsx'), /<DermBinButton/);
    assert.match(feRead('components/doctor/derm/DermFindingEditor.jsx'), /<DermBinButton/);
  });
});

describe('Customisable consultation — every section a module (10 Oct 2026, M1–M9)', () => {
  const { NEVER_HIDDEN } = require('../utils/consultationTools');
  test('the modules, in the clinic default order (M1, M7)', () => {
    assert.deepEqual(TOOL_IDS, ['notes', 'exam', 'plan', 'glp1', 'dermatology', 'orders']);   // 'assessment' retired 10 Oct
  });
  test('Orders can move but never hide (M3); Notes and Plan may be hidden (M4)', () => {
    assert.deepEqual(NEVER_HIDDEN, ['orders']);
    const p = cleanToolPrefs({ order: ['orders', 'notes'], hidden: ['orders', 'notes', 'plan'], open: ['orders', 'notes'] });
    assert.deepEqual(p, { order: ['orders', 'notes'], hidden: ['notes', 'plan'], open: ['orders'] });
  });
  test('the screen: modules from the layout, completion on an active diagnosis, separate notes and plan drafts', { skip: !hasFrontend }, () => {
    const tab = feRead('components/doctor/TodaysConsultationTab.jsx');
    assert.match(tab, /arrangeTools\(toolPrefs, modules\)/);
    assert.match(tab, /disabled=\{!hasActiveDx\}/);
    assert.doesNotMatch(tab, /ACCORDION_SECTIONS\s*=/);
    assert.match(tab, /useTodaysWork\(/);
    assert.match(feRead('components/doctor/ConsultationNotes.jsx'), /formKey: "consultation-notes"/);
    assert.match(feRead('components/doctor/TreatmentPlanModule.jsx'), /formKey: "treatment-plan"/);
    assert.match(feRead('constants/draftForms.js'), /'treatment-plan':/);
    assert.ok(!fs.existsSync(path.join(FE, 'components/doctor/ConsultationNotesPlan.jsx')), 'the combined notes + plan section is gone');
  });
});
