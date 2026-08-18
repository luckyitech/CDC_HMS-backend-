'use strict';

const test = require('node:test');
const assert = require('node:assert');
const E = require('../utils/thyroidUsEngine');

/* ---------- volume ---------- */
test('volume: ellipsoid L×H×W×0.52', () => {
  assert.strictEqual(E.volume(4, 2, 2), 8.3);      // 4*2*2*0.52 = 8.32 → 8.3
  assert.strictEqual(E.volume(5, 2, 2), 10.4);
});
test('volume: null when any dimension missing or ≤ 0', () => {
  assert.strictEqual(E.volume(4, 2, 0), null);
  assert.strictEqual(E.volume('', 2, 2), null);
  assert.strictEqual(E.volume(-1, 2, 2), null);
});

/* ---------- TI-RADS bands ---------- */
function nod(o) { return Object.assign({ fociStatus: 'none' }, o); }

test('TI-RADS TR1: all-zero solidless nodule', () => {
  const t = E.computeTirads(nod({ composition: 'cystic', echogenicity: 'anechoic', shape: 'wider_than_tall', margins: 'smooth' }));
  assert.strictEqual(t.points, 0);
  assert.strictEqual(t.category, 'TR1');
  assert.strictEqual(t.insufficient, false);
});
test('TI-RADS TR2 = 2 points', () => {
  const t = E.computeTirads(nod({ composition: 'solid', echogenicity: 'anechoic', shape: 'wider_than_tall', margins: 'smooth' }));
  assert.strictEqual(t.points, 2);
  assert.strictEqual(t.category, 'TR2');
});
test('TI-RADS TR3 = 3 points', () => {
  const t = E.computeTirads(nod({ composition: 'solid', echogenicity: 'isoechoic', shape: 'wider_than_tall', margins: 'smooth' }));
  assert.strictEqual(t.points, 3);
  assert.strictEqual(t.category, 'TR3');
});
test('TI-RADS TR4 (4–6 points)', () => {
  const t = E.computeTirads(nod({ composition: 'solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'lobulated' }));
  assert.strictEqual(t.points, 6); // 2+2+0+2
  assert.strictEqual(t.category, 'TR4');
});
test('TI-RADS TR5 (≥7 points), additive foci', () => {
  const t = E.computeTirads(nod({
    composition: 'solid', echogenicity: 'very_hypoechoic', shape: 'taller_than_wide', margins: 'irregular',
    fociStatus: 'present', fociPunctate: true,
  }));
  assert.strictEqual(t.points, 2 + 3 + 3 + 2 + 3); // 13
  assert.strictEqual(t.category, 'TR5');
});
test('TI-RADS additive foci sum (macro + punctate)', () => {
  const t = E.computeTirads(nod({
    composition: 'solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'smooth',
    fociStatus: 'present', fociMacrocalcification: true, fociPunctate: true,
  }));
  assert.strictEqual(t.breakdown.foci, 4); // 1 + 3
  assert.strictEqual(t.points, 2 + 2 + 0 + 0 + 4);
});

/* ---------- insufficient ---------- */
test('TI-RADS insufficient when a component missing', () => {
  const t = E.computeTirads(nod({ composition: 'solid', echogenicity: 'heterogeneous', shape: 'wider_than_tall', margins: 'smooth' }));
  assert.strictEqual(t.insufficient, true);
  assert.strictEqual(t.category, null);
  assert.strictEqual(t.points, null);
});
test('TI-RADS insufficient when foci not assessed', () => {
  const t = E.computeTirads({ composition: 'solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'smooth', fociStatus: 'not_assessed' });
  assert.strictEqual(t.insufficient, true);
});

/* ---------- FNA thresholds (informational) ---------- */
test('TI-RADS FNA thresholds', () => {
  const base = { composition: 'solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'lobulated', fociStatus: 'none' };
  const big = E.computeTirads(Object.assign({}, base, { length: 1.6, height: 1, width: 1 }));   // TR4, 1.6cm
  assert.strictEqual(big.category, 'TR4');
  assert.strictEqual(big.meetsFnaThreshold, true);   // TR4 ≥ 1.5
  const small = E.computeTirads(Object.assign({}, base, { length: 1.2, height: 1, width: 1 }));
  assert.strictEqual(small.meetsFnaThreshold, false);
});

/* ---------- BTA U suggestion ---------- */
test('BTA suggests U5 for solid very-hypo with malignant feature', () => {
  const b = E.suggestBtaU({ composition: 'solid', echogenicity: 'very_hypoechoic', margins: 'irregular', shape: 'taller_than_wide', fociStatus: 'present', fociPunctate: true });
  assert.strictEqual(b.suggested, 'U5');
});
test('BTA suggests U2 for cystic', () => {
  const b = E.suggestBtaU({ composition: 'cystic', echogenicity: 'anechoic', margins: 'smooth' });
  assert.strictEqual(b.suggested, 'U2');
});
test('BTA null when core descriptors missing', () => {
  const b = E.suggestBtaU({ composition: 'solid' });
  assert.strictEqual(b.suggested, null);
});

/* ---------- follicular concern ---------- */
test('follicular incomplete when anchors missing', () => {
  const f = E.follicularConcern({ echotexture: 'homogeneous' }, {});
  assert.strictEqual(f.concern, 'incomplete');
});
test('follicular HIGH on a higher-concern feature', () => {
  const f = E.follicularConcern(
    { echotexture: 'homogeneous', halo: 'interrupted', capsularInterface: 'smooth_intact' }, {});
  assert.strictEqual(f.concern, 'high');
  assert.ok(f.features.length >= 1);
});
test('follicular INTERMEDIATE on 1–2 intermediate features', () => {
  const f = E.follicularConcern(
    { echotexture: 'mildly_heterogeneous', halo: 'thin_complete', capsularInterface: 'smooth_intact' }, { echogenicity: 'isoechoic' });
  assert.strictEqual(f.concern, 'intermediate');
});
test('follicular LOW when complete and no features', () => {
  const f = E.follicularConcern(
    { echotexture: 'homogeneous', halo: 'thin_complete', capsularInterface: 'smooth_intact' }, { echogenicity: 'isoechoic', margins: 'smooth' });
  assert.strictEqual(f.concern, 'low');
});
test('follicular HIGH on ≥3 intermediate features', () => {
  const f = E.follicularConcern(
    { echotexture: 'markedly_heterogeneous', halo: 'thick_complete', capsularInterface: 'focally_irregular', tubercleInNodule: 'present' },
    { echogenicity: 'hypoechoic' });
  assert.strictEqual(f.concern, 'high');
});

/* ---------- ablation figures ---------- */
test('ablation: solid/cystic split from dimensions', () => {
  const a = E.ablationFigures({ length: 4, height: 2, width: 2, cysticLength: 2, cysticHeight: 2, cysticWidth: 2 });
  assert.strictEqual(a.total, 8.3);
  assert.strictEqual(a.cysticVolume, 4.2);
  assert.ok(a.solidPercent > 0 && a.solidPercent < 100);
});
test('ablation: cystic % estimate fallback', () => {
  const a = E.ablationFigures({ length: 4, height: 2, width: 2, cysticPercentEstimate: 50 });
  assert.ok(a.cysticVolume > 0);
});
test('ablation gate fires for Bethesda III/IV + concern + RFA', () => {
  const req = E.ablationGateRequired({ previousCytology: 'bethesda_4' }, { concern: 'high' }, ['RFA']);
  assert.strictEqual(req, true);
  const noReq = E.ablationGateRequired({ previousCytology: 'bethesda_2' }, { concern: 'high' }, ['RFA']);
  assert.strictEqual(noReq, false);
});

/* ---------- validation ---------- */
test('validation errors: empty report', () => {
  const { errors } = E.validateReport({}, []);
  assert.ok(errors.some((e) => /indication/i.test(e)));
  assert.ok(errors.some((e) => /exam date/i.test(e)));
  assert.ok(errors.some((e) => /lymph node/i.test(e)));
});
test('validation: nodule without BTA is an error', () => {
  const { errors } = E.validateReport(
    { indications: ['nodule'], examDate: '2026-08-18', lymphNodeAssessment: 'normal', conclusion: ['x'], plan: ['y'] },
    [{ noduleNumber: 1, length: 1, height: 1, width: 1 }]);
  assert.ok(errors.some((e) => /BTA U category not confirmed/i.test(e)));
});
test('validation: clean report has no errors', () => {
  const { errors } = E.validateReport(
    { indications: ['nodule'], examDate: '2026-08-18', lymphNodeAssessment: 'normal', conclusion: ['x'], plan: ['y'] },
    [{ noduleNumber: 1, length: 1, height: 1, width: 1, btaCategory: 'U3' }]);
  assert.deepStrictEqual(errors, []);
});
test('validation warning: axis swap H>L', () => {
  const { warnings } = E.validateReport(
    { indications: ['x'], examDate: '2026-08-18', lymphNodeAssessment: 'normal', conclusion: ['x'], plan: ['y'], noNodules: true,
      rightLength: 2, rightHeight: 4, rightWidth: 2 }, []);
  assert.ok(warnings.some((w) => /axis swap/i.test(w)));
});

/* ---------- generators ---------- */
test('conclusion: dominant lesion first', () => {
  const nodules = [
    { noduleNumber: 1, lobe: 'right', composition: 'cystic', echogenicity: 'anechoic', shape: 'wider_than_tall', margins: 'smooth', fociStatus: 'none', btaCategory: 'U2', length: 1, height: 1, width: 1 },
    { noduleNumber: 2, lobe: 'left', composition: 'solid', echogenicity: 'very_hypoechoic', shape: 'taller_than_wide', margins: 'irregular', fociStatus: 'present', fociPunctate: true, btaCategory: 'U5', length: 2, height: 1.5, width: 1.5 },
  ];
  const c = E.generateConclusion({ lymphNodeAssessment: 'normal' }, nodules);
  assert.ok(/Dominant nodule \(left\)/.test(c[0]));   // the TR5 one leads
  assert.ok(/TR5/.test(c[0]));
});
test('narrative: no-nodule study states it', () => {
  const n = E.generateNarrative({ glandSize: 'normal', noNodules: true, lymphNodeAssessment: 'normal' }, []);
  assert.ok(/No discrete thyroid nodules/.test(n));
});

/* ---------- versions ---------- */
test('version stamps present', () => {
  assert.strictEqual(E.VERSIONS.tirads, 'ACR-2017');
  assert.strictEqual(E.computeTirads(nod({ composition: 'solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'smooth' })).version, 'ACR-2017');
});
