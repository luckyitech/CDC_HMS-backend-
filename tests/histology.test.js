// Dermatology Phase 3 (7 Oct 2026) — histology / cytology and skin procedures:
// pure rules and the guard-rails around them. No database.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../utils/histologyRules');
const P = require('../utils/dermProcedures');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const skin = { kind: 'histology', siteType: 'skin', findingId: 4, specimenType: 'punch', clinicalDetails: 'Exclude melanoma' };

describe('a histology / cytology request', () => {
  test('kind, site and a specimen type that fits the kind', () => {
    assert.equal(R.cleanRequest({}).field, 'kind');
    assert.equal(R.cleanRequest({ kind: 'histology' }).field, 'siteType');
    assert.equal(R.cleanRequest({ ...skin, specimenType: 'fnac' }).field, 'specimenType');
    assert.equal(R.cleanRequest({ ...skin, kind: 'cytology', specimenType: 'punch' }).field, 'specimenType');
    assert.ok(R.cleanRequest({ ...skin, kind: 'cytology', specimenType: 'fnac' }).ok);
    assert.ok(R.cleanRequest({ ...skin, specimenType: 'core_needle' }).ok);
  });
  test('a skin specimen names a finding', () => {
    assert.equal(R.cleanRequest({ ...skin, findingId: undefined }).field, 'findingId');
    assert.equal(R.cleanRequest({ ...skin, findingId: 'x' }).field, 'findingId');
  });
  test('a thyroid nodule needs a lobe; TI-RADS is TR1–TR5', () => {
    const t = { ...skin, siteType: 'thyroid', kind: 'cytology', specimenType: 'fnac', findingId: undefined };
    assert.equal(R.cleanRequest(t).field, 'thyroidLobe');
    assert.equal(R.cleanRequest({ ...t, thyroidLobe: 'right', tirads: 'TR6' }).field, 'tirads');
    const ok = R.cleanRequest({ ...t, thyroidLobe: 'right', tirads: 'TR5', noduleLabel: ' R2 ' });
    assert.equal(ok.value.noduleLabel, 'R2');
    assert.equal(ok.value.findingId, null, 'a finding id is dropped off a non-skin specimen');
  });
  test('a lymph node or other site must be described', () => {
    assert.equal(R.cleanRequest({ ...skin, siteType: 'lymph_node' }).field, 'siteText');
    assert.ok(R.cleanRequest({ ...skin, siteType: 'other', siteText: 'Left axilla' }).ok);
  });
  test('clinical details are required; pieces 1–50', () => {
    assert.equal(R.cleanRequest({ ...skin, clinicalDetails: ' ' }).field, 'clinicalDetails');
    assert.equal(R.cleanRequest({ ...skin, pieces: 0 }).field, 'pieces');
    assert.equal(R.cleanRequest({ ...skin, pieces: 2.5 }).field, 'pieces');
    assert.equal(R.cleanRequest({ ...skin, pieces: '3' }).value.pieces, 3);
  });
  test('"also record the procedure" only when sent as true', () => {
    assert.equal(R.cleanRequest({ ...skin, alsoRecordProcedure: 'yes' }).value.alsoRecordProcedure, false);
    assert.equal(R.cleanRequest({ ...skin, alsoRecordProcedure: true }).value.alsoRecordProcedure, true);
  });
});

describe('a result (H4)', () => {
  const hist = { kind: 'histology', siteType: 'skin' };
  const thy = { kind: 'cytology', siteType: 'thyroid' };
  const node = { kind: 'cytology', siteType: 'lymph_node' };
  test('the shape follows the request', () => {
    assert.equal(R.resultShape(hist), 'histology');
    assert.equal(R.resultShape(thy), 'bethesda');
    assert.equal(R.resultShape(node), 'cytology');
  });
  test('histology: diagnosis required; a margin distance needs a margin status', () => {
    assert.equal(R.cleanResult(hist, {}).field, 'resultDiagnosis');
    assert.equal(R.cleanResult(hist, { resultDiagnosis: 'BCC', marginMm: 1 }).field, 'margins');
    assert.equal(R.cleanResult(hist, { resultDiagnosis: 'BCC', margins: 'not_assessed', marginMm: 1 }).field, 'margins');
    assert.equal(R.cleanResult(hist, { resultDiagnosis: 'BCC', margins: 'close', marginMm: '0.54' }).value.marginMm, 0.5);
  });
  test('thyroid cytology: Bethesda I–VI required', () => {
    assert.equal(R.cleanResult(thy, { resultDiagnosis: 'x' }).field, 'bethesda');
    assert.equal(R.cleanResult(thy, { bethesda: 'VII' }).field, 'bethesda');
    const ok = R.cleanResult(thy, { bethesda: 'II', margins: 'clear', marginMm: 3, cytologyCategory: 'benign' });
    assert.equal(ok.value.margins, null);
    assert.equal(ok.value.marginMm, null);
    assert.equal(ok.value.cytologyCategory, null);
  });
  test('other cytology: a category', () => {
    assert.equal(R.cleanResult(node, {}).field, 'cytologyCategory');
    assert.equal(R.cleanResult(node, { cytologyCategory: 'malignant' }).value.bethesda, null);
  });
  test('report date and document', () => {
    assert.equal(R.cleanResult(thy, { bethesda: 'II', reportDate: '5/10/2026' }).field, 'reportDate');
    assert.equal(R.cleanResult(thy, { bethesda: 'II', reportDocumentId: 'x' }).field, 'reportDocumentId');
  });
  test('one-line summaries', () => {
    assert.equal(R.resultSummary({ status: 'awaiting' }), null);
    assert.equal(R.resultSummary({ status: 'resulted', bethesda: 'IV', resultDiagnosis: 'Follicular neoplasm' }), 'Bethesda IV — Follicular neoplasm');
    assert.equal(R.resultSummary({ status: 'resulted', cytologyCategory: 'non_diagnostic' }), 'Non-diagnostic');
    assert.equal(R.resultSummary({ status: 'resulted', resultDiagnosis: 'BCC', margins: 'involved' }), 'BCC; margins involved');
    assert.equal(R.resultSummary({ status: 'resulted', resultDiagnosis: 'BCC', margins: 'not_assessed' }), 'BCC');
  });
  test('who may correct without a reason: the resulter, the same clinic day', () => {
    const r = { resultById: 7, resultAt: new Date(), resultDay: '2026-10-07' };
    assert.equal(R.resultChangeMode(r, 7, '2026-10-07'), 'edit');
    assert.equal(R.resultChangeMode(r, 8, '2026-10-07'), 'amend');
    assert.equal(R.resultChangeMode(r, 7, '2026-10-08'), 'amend');
  });
});

describe('overdue (H7)', () => {
  test('awaiting more than 21 days', () => {
    assert.equal(R.isOverdue({ status: 'awaiting', visitDate: '2026-09-16' }, '2026-10-07'), false);
    assert.equal(R.isOverdue({ status: 'awaiting', visitDate: '2026-09-15' }, '2026-10-07'), true);
    assert.equal(R.isOverdue({ status: 'resulted', visitDate: '2026-01-01' }, '2026-10-07'), false);
    assert.equal(R.isOverdue({ status: 'cancelled', visitDate: '2026-01-01' }, '2026-10-07'), false);
  });
});

describe('procedures (H8)', () => {
  test('the clinic list: trimmed, de-duplicated, never empty', () => {
    assert.deepEqual(P.cleanProcedureList([' Cryotherapy ', 'cryotherapy', '', 'Peel']).value, ['Cryotherapy', 'Peel']);
    assert.equal(P.cleanProcedureList([]).ok, false);
    assert.equal(P.cleanProcedureList('Cryotherapy').ok, false);
    assert.equal(P.cleanProcedureList(['x'.repeat(121)]).ok, false);
  });
  test('an unreadable setting falls back to the starter list', () => {
    assert.deepEqual(P.parseProcedureList(null), P.DEFAULT_PROCEDURES);
    assert.deepEqual(P.parseProcedureList('{oops'), P.DEFAULT_PROCEDURES);
    assert.deepEqual(P.parseProcedureList('["A"]'), ['A']);
  });
  test('a procedure: name from the list, at least one finding', () => {
    assert.equal(P.cleanProcedure({ name: 'Laser', findingIds: [1] }).field, 'name');
    assert.equal(P.cleanProcedure({ name: 'cryotherapy', findingIds: [1] }).value.name, 'Cryotherapy');
    assert.equal(P.cleanProcedure({ name: 'Cryotherapy', findingIds: [] }).field, 'findingIds');
    assert.deepEqual(P.cleanProcedure({ name: 'Cryotherapy', findingIds: [3, '1', 3] }).value.findingIds, [1, 3]);
  });
  test('an edit keeps a name that has since left the list', () => {
    const r = P.cleanProcedure({ name: 'Old thing' }, ['Cryotherapy'], { partial: true, currentName: 'Old thing' });
    assert.equal(r.value.name, 'Old thing');
    assert.deepEqual(P.cleanProcedure({ details: 'x' }, ['Cryotherapy'], { partial: true }).value, { details: 'x' });
  });
  test('same-day author edits; anyone else, any later day, amends', () => {
    const p = { performedById: 4, procedureDate: '2026-10-07' };
    assert.equal(P.procedureChangeMode(p, 4, '2026-10-07'), 'edit');
    assert.equal(P.procedureChangeMode(p, 5, '2026-10-07'), 'amend');
    assert.equal(P.procedureChangeMode(p, 4, '2026-10-08'), 'amend');
  });
  test('every skin biopsy type records as a listed procedure (H9)', () => {
    for (const t of R.SKIN_BIOPSY_TYPES) assert.ok(P.DEFAULT_PROCEDURES.includes(P.BIOPSY_PROCEDURE[t]), t);
  });
});

describe('the frontend offers exactly the backend lists', () => {
  const FE = path.join(ROOT, '..', 'frontend', 'cdc-hms', 'src');
  const has = fs.existsSync(FE);
  const ids = (src, name) => {
    const block = src.split(`export const ${name} = [`)[1].split('];')[0];
    return [...block.matchAll(/id: '([A-Za-z_]+)'/g)].map((m) => m[1]);
  };
  test('kinds, sites, specimen types, fixatives, lobes, margins, Bethesda, categories', () => {
    if (!has) return;   // backend-only checkout
    const src = fs.readFileSync(path.join(FE, 'constants/histology.js'), 'utf8');
    assert.deepEqual(ids(src, 'KINDS'), R.KINDS);
    assert.deepEqual(ids(src, 'SITE_TYPES'), R.SITE_TYPES);
    assert.deepEqual(ids(src, 'TISSUE_TYPES'), R.TISSUE_TYPES);
    assert.deepEqual(ids(src, 'CYTO_TYPES'), R.CYTO_TYPES);
    assert.deepEqual(ids(src, 'FIXATIVES'), R.FIXATIVES);
    assert.deepEqual(ids(src, 'LOBES'), R.LOBES);
    assert.deepEqual(ids(src, 'MARGINS'), R.MARGINS);
    assert.deepEqual(ids(src, 'BETHESDA'), R.BETHESDA);
    assert.deepEqual(ids(src, 'CYTO_CATEGORIES'), R.CYTO_CATEGORIES);
  });
});

describe('guard-rails', () => {
  test('every histology route sits behind login and its own module switch', () => {
    assert.match(read('routes/histology.js'), /router\.use\(authenticate, requireModule\('histology'\)\)/);
    assert.match(read('services/clinicModules.js'), /key: 'histology'/);
    assert.match(read('app.js'), /'\/api\/histology'/);
  });
  test('writes are doctor or histology.record — never the admin.access bypass', () => {
    const src = read('routes/histology.js');
    const writes = [...src.matchAll(/router\.(post|put|patch|delete)\([^\n]*authorize\(([^)]*)\)/g)];
    assert.ok(writes.length >= 3);
    for (const m of writes) {
      assert.doesNotMatch(m[2], /'admin'/, m[0]);
      assert.match(m[2], /HISTOLOGY_RECORD/, m[0]);
    }
  });
  test('nothing hard-deletes a request, a result or a procedure', () => {
    for (const f of ['controllers/histologyController.js', 'controllers/dermProcedureController.js']) {
      assert.doesNotMatch(read(f), /HistologyRequest\.destroy|HistologyEdit\.destroy|DermProcedure\.destroy|DermEdit\.destroy|LabTest\.destroy|\.destroy\(\)/, f);
    }
  });
  test('attribution comes from the token', () => {
    for (const f of ['controllers/histologyController.js', 'controllers/dermProcedureController.js']) {
      assert.doesNotMatch(read(f), /(requestedById|resultById|cancelledById|performedById|editedById|orderedById|errorById|amendedById):\s*req\.body/, f);
    }
  });
  test('merge-aware: reads across the family, writes refuse a merged-away file', () => {
    const src = read('controllers/histologyController.js');
    assert.match(src, /PatientId: \{ \[Op\.in\]: family\.patientIds \}/);
    assert.match(src, /family\.isDeactivated/);
    assert.match(src, /PatientId: family\.patient\.id/);
  });
  test('the procedure list is kept in settings on the admin gate, behind the Dermatology switch', () => {
    assert.match(read('routes/settings.js'), /router\.put\('\/derm-procedures', authenticate, authorize\('admin', 'config\.write'\), requireModule\('dermatology'\)/);
  });
  test('the migration refuses a lossy down', () => {
    assert.match(read('migrations/20260928000023-histology-and-derm-procedures.js'), /down refused/);
  });
});
