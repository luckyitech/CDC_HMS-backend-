// Dermatology — the structured skin examination (9 Oct 2026). Pure; no database.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const X = require('../utils/dermExam');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('"Other…" on every choice field', () => {
  test('a fixed word stays a token; its label or spacing typed by hand becomes the token', () => {
    assert.equal(X.cleanOne('configuration', 'annular'), 'annular');
    assert.equal(X.cleanOne('configuration', 'Annular'), 'annular');
    assert.equal(X.cleanOne('surface', 'ulcerated'), 'ulcerated');
    assert.equal(X.cleanOne('colours', 'Flesh-coloured'), 'skin_coloured');
    assert.equal(X.cleanOne('pattern', 'photo exposed'), 'photo_exposed');
  });
  test('a typed word is kept as typed (trimmed, single-spaced)', () => {
    assert.equal(X.cleanOne('pattern', '  Sporotrichoid   spread '), 'Sporotrichoid spread');
  });
  test('refused: commas, over 40 characters, no letter', () => {
    assert.equal(X.cleanOne('pattern', 'a,b'), undefined);
    assert.equal(X.cleanOne('pattern', 'x'.repeat(41)), undefined);
    assert.equal(X.cleanOne('pattern', '12'), undefined);
  });
  test('lists: duplicates (any case) dropped, joined with commas', () => {
    assert.equal(X.cleanMany('border', ['well_defined', 'Raised', 'raised', 'Rolled']), 'well_defined,raised,Rolled');
    assert.equal(X.cleanMany('border', []), null);
  });
  test('every choice field in both levels takes Other (not Status today or Measured by)', () => {
    for (const f of [...X.LOOK_FIELDS, ...X.EXAM_FIELDS].filter((x) => x.kind === 'one' || x.kind === 'many')) {
      assert.equal(X.cleanOne(f.key, 'My own word'), 'My own word', f.key);
    }
    assert.equal(X.CHOICE_FIELDS.statusToday, undefined);
    assert.equal(X.CHOICE_FIELDS.measuredBy, undefined);
  });
});

describe('one look', () => {
  test('blank = not recorded; None is a recorded answer', () => {
    const v = X.cleanLookExam({ scale: 'none' }).value;
    assert.equal(v.scale, 'none');
    assert.equal(v.crust, null);
  });
  test('ulcer base only with ulceration present', () => {
    assert.equal(X.cleanLookExam({ ulceration: 'none', ulcerBase: 'clean' }).value.ulcerBase, null);
    assert.equal(X.cleanLookExam({ ulceration: 'present', ulcerBase: 'clean' }).value.ulcerBase, 'clean');
  });
  test('number of lesions: a count or innumerable / confluent, not both', () => {
    const v = X.cleanLookExam({ lesionCount: 8, lesionCountKind: 'innumerable' }).value;
    assert.equal(v.lesionCount, null);
    assert.equal(v.lesionCountKind, 'innumerable');
    assert.equal(X.cleanLookExam({ lesionCount: 2.5 }).field, 'lesionCount');
  });
  test('BSA is 0.1–100 %', () => {
    assert.equal(X.cleanLookExam({ bsaPercent: '2.04' }).value.bsaPercent, 2);
    assert.equal(X.cleanLookExam({ bsaPercent: 101 }).field, 'bsaPercent');
  });
  test('dermoscopy fields are kept only when dermoscopy was performed', () => {
    assert.equal(X.cleanLookExam({ dsGlobal: 'reticular' }).value.dsGlobal, null);
    const v = X.cleanLookExam({ dermoscopy: true, dsGlobal: 'reticular', dsVascular: ['dotted', 'Crown vessels'] }).value;
    assert.equal(v.dermoscopy, true);
    assert.equal(v.dsVascular, 'dotted,Crown vessels');
  });
});

describe("today's whole-skin exam", () => {
  test('a part not examined keeps none of its fields', () => {
    const v = X.cleanSkinExam({ hairExamined: false, scalp: 'scaly', mucosaExamined: true, oral: 'normal' }).value;
    assert.equal(v.scalp, null);
    assert.equal(v.oral, 'normal');
  });
  test('nothing examined and no notes is refused', () => {
    assert.equal(X.cleanSkinExam({}).ok, false);
  });
  test('follow-on fields only when they apply', () => {
    const v = X.cleanSkinExam({ hairExamined: true, pullTest: 'negative', pullTestSite: 'vertex', pullTestCount: 3, hairDensity: 'normal', hairDensityPattern: ['patchy'] }).value;
    assert.equal(v.pullTestSite, null);
    assert.equal(v.pullTestCount, null);
    assert.equal(v.hairDensityPattern, null);
  });
  test('nails affected uses the nail chart words, or a typed one', () => {
    assert.equal(X.cleanSkinExam({ nailsExamined: true, nailsAffected: ['lf1', 'rt1'] }).value.nailsAffected, 'lf1,rt1');
    assert.equal(X.phrase('nailsAffected', 'lf1,rt1'), 'left thumb, right great toe');
  });
});

describe('vocabulary', () => {
  test('typed words per field, most used first; fixed and legacy words ignored', () => {
    const t = X.typedTerms([
      { pattern: 'photo_exposed,Sporotrichoid' }, { pattern: 'sporotrichoid' }, { pattern: 'Zosteriform' },
      { border: 'regular' }, { nailPlate: 'normal,Beau lines' },
    ]);
    assert.deepEqual(t.pattern, [{ name: 'Sporotrichoid', uses: 2 }, { name: 'Zosteriform', uses: 1 }]);
    assert.equal(t.border, undefined);
    assert.deepEqual(t.nailPlate, [{ name: 'Beau lines', uses: 1 }]);
  });
});

describe('guard-rails', () => {
  test('migration …028 adds a column for every structured look field', () => {
    const mig = read('migrations/20260928000028-derm-structured-skin-exam.js');
    for (const k of X.LOOK_EXAM_KEYS) {
      if (['border', 'surface'].includes(k)) continue;   // widened, not added
      assert.match(mig, new RegExp(`\\['${k}', '`), k);
    }
  });
  test('the model lists every look field, so no query names a missing column', () => {
    const model = read('models/DermObservation.js');
    for (const k of ['sizeMinMm', 'sizeMaxMm', ...X.LOOK_EXAM_KEYS]) assert.match(model, new RegExp(`\\b${k}:`), k);
    const exam = read('models/DermSkinExam.js');
    for (const k of X.SKIN_EXAM_KEYS) assert.match(exam, new RegExp(`\\b${k}:`), k);
  });
  test('skin-exam routes: read like the record (logged), written by doctor / derm.record', () => {
    const routes = read('routes/derm.js');
    assert.match(routes, /router\.get\('\/patients\/:uhid\/skin-exam', authorize\('doctor', 'nurse', 'admin', PERMISSIONS\.CLINICAL_VIEW\), logPatientAccess\('dermatology'\), skinExam\.getSkinExam\)/);
    assert.match(routes, /router\.put\('\/patients\/:uhid\/skin-exam', authorize\('doctor', PERMISSIONS\.DERM_RECORD\), skinExam\.saveSkinExam\)/);
    assert.match(routes, /router\.put\('\/skin-exams\/:id', authorize\('doctor', PERMISSIONS\.DERM_RECORD\), skinExam\.amendSkinExam\)/);
  });
  test('the skin-exam controller is merge-aware and takes the author from the JWT', () => {
    const c = read('controllers/dermSkinExamController.js');
    assert.match(c, /PatientId: \{ \[Op\.in\]: family\.patientIds \}/);
    assert.match(c, /PatientId: family\.patient\.id, visitDate: today, doctorId: req\.user\.id/);
    assert.match(c, /family\.isDeactivated/);
    assert.doesNotMatch(c, /\.destroy\(/);
  });
});

describe('the screen mirrors the server', () => {
  // backend/ and frontend/ sit side by side on the development Mac; skipped where they don't.
  const mirror = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'components', 'doctor', 'derm', 'dermExam.js');
  test('frontend dermExam.js has the same sections, fields and fixed words', { skip: !fs.existsSync(mirror) && 'frontend not alongside' }, async () => {
    const F = await import(require('url').pathToFileURL(mirror).href);
    const shape = (sections) => JSON.stringify(sections);
    assert.equal(shape(F.LOOK_SECTIONS), shape(X.LOOK_SECTIONS));
    assert.equal(shape(F.EXAM_SECTIONS), shape(X.EXAM_SECTIONS));
    assert.deepEqual(F.LOOK_EXAM_KEYS, X.LOOK_EXAM_KEYS);
    assert.deepEqual(F.SKIN_EXAM_KEYS, X.SKIN_EXAM_KEYS);
    assert.equal(F.MAX_TERM, X.MAX_TERM);
  });
});
