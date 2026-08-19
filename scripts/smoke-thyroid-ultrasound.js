/* End-to-end smoke test for the thyroid US backend against a live DB.
 * Refuses to run against a production host. Builds base tables + thyroid
 * migrations, then drives the controller through create → edit → nodule →
 * follicular → preview → sign → getFull with mock req/res. */
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'cdc';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'cdc';
process.env.DB_NAME = process.env.DB_NAME || 'cdc_hms';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke';

if (/cdiabetescentre/i.test(process.env.DB_HOST || '')) { console.error('Refusing to run against production.'); process.exit(1); }

const path = require('path');
const db = require('./../models');
const { sequelize, User, Patient, UltrasoundImage } = db;
const Sequelize = require('sequelize');
const qi = sequelize.getQueryInterface();

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗', msg); } };

// mock res that captures the last status+body
function mkRes() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
async function call(fn, req) { const res = mkRes(); await fn(req, res); return res; }

const MIGRATIONS = [
  '20260819000001-create-thyroid-ultrasounds.js',
  '20260819000002-create-thyroid-nodules.js',
  '20260819000003-create-thyroid-follicular-assessments.js',
  '20260819000004-create-thyroid-us-catalog-items.js',
  '20260819000005-seed-thyroid-us-catalog.js',
  '20260819000006-create-thyroid-ultrasound-images.js',
];

(async () => {
  try {
    await sequelize.authenticate();
    // clean slate
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['ThyroidUltrasoundImages', 'ThyroidNoduleFollicularAssessments', 'ThyroidNodules', 'ThyroidUltrasounds', 'ThyroidUsCatalogItems', 'UltrasoundImages', 'Patients', 'Users']) {
      await sequelize.query('DROP TABLE IF EXISTS `' + t + '`');
    }
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

    // base tables from the real models, then thyroid migrations
    await User.sync({ force: true });
    await Patient.sync({ force: true });
    await UltrasoundImage.sync({ force: true });
    for (const f of MIGRATIONS) await require(path.join(__dirname, '..', 'migrations', f)).up(qi, Sequelize);

    const ctrl = require('../controllers/thyroidUltrasoundController');

    // seed a tech user and a patient
    const tech = await User.create({ firstName: 'Aisha', lastName: 'Mwangi', role: 'staff', email: 'tech@cdc.local', password: 'x' });
    const patient = await Patient.create({ uhid: 'CDC001', firstName: 'Test', lastName: 'Patient', gender: 'Female' });
    const reqUser = { id: tech.id, role: tech.role, firstName: tech.firstName, lastName: tech.lastName };

    // 1. create
    let res = await call(ctrl.create, { body: { uhid: 'CDC001', studyType: 'full', examDate: '2026-08-18' }, user: reqUser });
    ok(res.code === 201 && res.body.success, 'create returns 201');
    const id = res.body.data.id;
    ok(/^TUS-2026-\d{5}$/.test(res.body.data.reportNumber), 'report number format');
    ok(res.body.data.tiradsVersion === 'ACR-2017', 'version stamped on create');

    // 2. patch appearance + dims + indication + nodes + conclusion + plan
    res = await call(ctrl.patch, { params: { id }, user: reqUser, body: {
      indications: ['incidental_nodule'], glandSize: 'normal', echotexture: 'homogeneous', vascularity: 'normal',
      rightLength: 4, rightHeight: 2, rightWidth: 2, leftLength: 4, leftHeight: 2, leftWidth: 2,
      lymphNodeAssessment: 'normal', conclusion: ['x'], plan: ['surveillance_12'],
    } });
    ok(res.body.success, 'patch saves');
    ok(Number(res.body.data.rightVolume) === 8.3, 'right lobe volume computed on patch (' + res.body.data.rightVolume + ')');
    ok(Number(res.body.data.totalVolume) === 16.6, 'total volume computed (' + res.body.data.totalVolume + ')');

    // 3. add a suspicious nodule → TR5 expected
    res = await call(ctrl.addNodule, { params: { id }, user: reqUser, body: {
      lobe: 'left', pole: 'mid', length: 2, height: 1.6, width: 1.5,
      composition: 'solid', echogenicity: 'very_hypoechoic', shape: 'taller_than_wide', margins: 'irregular',
      fociStatus: 'present', fociPunctate: true, previousCytology: 'bethesda_4',
    } });
    ok(res.code === 201, 'addNodule 201');
    const nid = res.body.data.id;
    ok(res.body.data.tiradsCategory === 'TR5', 'nodule scored TR5 (' + res.body.data.tiradsCategory + ')');
    ok(res.body.data.btaSuggested === 'U5', 'BTA suggested U5 (' + res.body.data.btaSuggested + ')');
    ok(Number(res.body.data.volume) === 2.5, 'nodule volume computed (' + res.body.data.volume + ')');

    // 4. confirm BTA on the nodule
    res = await call(ctrl.updateNodule, { params: { id, nid }, user: reqUser, body: { btaCategory: 'U5', btaRationale: 'confirmed' } });
    ok(res.body.data.btaCategory === 'U5', 'BTA confirmed');
    ok(res.body.data.tiradsCategory === 'TR5', 'TI-RADS retained after update');

    // 5. follicular assessment → HIGH (interrupted halo is a higher-concern feature)
    res = await call(ctrl.upsertFollicular, { params: { id, nid }, user: reqUser, body: {
      echotexture: 'markedly_heterogeneous', halo: 'interrupted', capsularInterface: 'smooth_intact',
    } });
    ok(res.body.data.concern.concern === 'high', 'follicular concern HIGH (' + res.body.data.concern.concern + ')');

    // 6. preview
    res = await call(ctrl.preview, { params: { id }, user: reqUser, body: {} });
    ok(res.body.success, 'preview runs');
    ok(Array.isArray(res.body.data.errors) && res.body.data.errors.length === 0, 'preview: no blocking errors (' + JSON.stringify(res.body.data.errors) + ')');
    ok(/TR5/.test(res.body.data.narrative || ''), 'preview narrative mentions the TR5 nodule');

    // 7. sign — plan has surveillance (no ablation), so no ablation gate
    res = await call(ctrl.sign, { params: { id }, user: reqUser, body: { confirmWarnings: true, conclusion: ['Dominant left nodule TR5/U5.'], plan: ['fna'] } });
    ok(res.body.success && res.body.data.status === 'signed', 'report signed');
    ok(!!res.body.data.reportSnapshot, 'snapshot frozen');
    ok(res.body.data.signedName === 'Aisha Mwangi', 'signed by tech, no Dr prefix (' + res.body.data.signedName + ')');

    // 8. ablation gate: build a second report that DOES choose ablation → sign must block
    let r2 = await call(ctrl.create, { body: { uhid: 'CDC001' }, user: reqUser });
    const id2 = r2.body.data.id;
    await call(ctrl.patch, { params: { id: id2 }, user: reqUser, body: { indications: ['nodule_palpation'], examDate: '2026-08-18', lymphNodeAssessment: 'normal', conclusion: ['x'], plan: ['rfa'] } });
    let n2 = await call(ctrl.addNodule, { params: { id: id2 }, user: reqUser, body: { lobe: 'right', length: 3, height: 2, width: 2, composition: 'mixed_cystic_solid', echogenicity: 'hypoechoic', shape: 'wider_than_tall', margins: 'lobulated', fociStatus: 'none', btaCategory: 'U4', previousCytology: 'bethesda_4' } });
    await call(ctrl.upsertFollicular, { params: { id: id2, nid: n2.body.data.id }, user: reqUser, body: { echotexture: 'markedly_heterogeneous', halo: 'interrupted', capsularInterface: 'smooth_intact' } });
    res = await call(ctrl.sign, { params: { id: id2 }, user: reqUser, body: { confirmWarnings: true, conclusion: ['x'], plan: ['rfa'] } });
    ok(res.code === 422 && res.body.needsAblationAck, 'ablation gate blocks sign without acknowledgement');
    res = await call(ctrl.sign, { params: { id: id2 }, user: reqUser, body: { confirmWarnings: true, ablationWarningAcknowledged: true, conclusion: ['x'], plan: ['rfa'] } });
    ok(res.body.data && res.body.data.status === 'signed', 'sign succeeds with ablation acknowledgement');
    ok(!!res.body.data.ablationWarningAcknowledgedAt, 'ablation acknowledgement stamped');

    // 9. getFull on the signed report
    res = await call(ctrl.getFull, { params: { id }, user: reqUser });
    ok(res.body.success, 'getFull runs');
    ok(res.body.data.nodules.length === 1, 'getFull returns nodules');
    ok(res.body.data.permissions.canEdit === false, 'signed report not editable');
    ok(res.body.data.permissions.canReopen === true, 'author can reopen same day');

    // 10. reopen same day
    res = await call(ctrl.reopen, { params: { id }, user: reqUser, body: {} });
    ok(res.body.data.status === 'draft', 'reopen returns to draft same day');

    // 11. catalog
    res = await call(ctrl.listCatalog, { params: { type: 'indication' }, user: reqUser });
    ok(res.body.data.length >= 11, 'indication catalog seeded (' + res.body.data.length + ')');

    console.log(`\nSMOKE: ${pass} passed, ${fail} failed`);
    await sequelize.close();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('SMOKE CRASHED:', e.message);
    console.error((e.stack || '').split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
})();
