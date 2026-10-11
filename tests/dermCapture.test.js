// Skin photos from a phone + area photos (8 Oct 2026). Pure rules and guard-rails.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cap = require('../utils/dermCapture');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the QR token', () => {
  test('is long, random, and only its hash is kept', () => {
    const a = cap.newToken(); const b = cap.newToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 32);
    assert.equal(cap.hashToken(a).length, 64);
    assert.notEqual(cap.hashToken(a), a);
    assert.ok(cap.sameHash(cap.hashToken(a), cap.hashToken(a)));
    assert.ok(!cap.sameHash(cap.hashToken(a), cap.hashToken(b)));
    assert.ok(!cap.sameHash(null, cap.hashToken(a)));
  });
  test('a session is unusable once closed, expired or full', () => {
    const live = { expiresAt: new Date(Date.now() + 60000), photoCount: 0, closedAt: null };
    assert.equal(cap.sessionProblem(live), null);
    assert.equal(cap.sessionProblem(null)[0], 404);
    assert.equal(cap.sessionProblem({ ...live, closedAt: new Date() })[0], 410);
    assert.equal(cap.sessionProblem({ ...live, expiresAt: new Date(Date.now() - 1) })[0], 410);
    assert.equal(cap.sessionProblem({ ...live, photoCount: cap.MAX_PHOTOS_PER_SESSION })[0], 409);
    assert.equal(cap.CAPTURE_MINUTES, 10);
  });
});

describe('areas on a photo', () => {
  test('known region ids only, de-duplicated; JSON text or an array', () => {
    assert.deepEqual(cap.cleanAreas('["f-forehead","f-forehead","f-midface"]').value, ['f-forehead', 'f-midface']);
    assert.deepEqual(cap.cleanAreas(['b-scalp']).value, ['b-scalp']);
    assert.deepEqual(cap.cleanAreas(undefined).value, []);
    assert.equal(cap.cleanAreas('not json').ok, false);
    assert.equal(cap.cleanAreas(['nowhere']).ok, false);
  });
  test('a phone can only tag the areas the doctor chose', () => {
    assert.equal(cap.cleanAreas(['f-forehead'], ['f-forehead', 'f-midface']).ok, true);
    assert.equal(cap.cleanAreas(['f-abdo'], ['f-forehead']).ok, false);
  });
});

describe('guard-rails', () => {
  const routes = read('routes/derm.js');
  const phone = read('routes/dermCapture.js');
  const ctl = read('controllers/dermCaptureController.js');
  const photos = read('controllers/dermPhotoController.js');
  const app = read('app.js');
  test('the computer side is doctors / derm.record, behind login and the module switch', () => {
    for (const r of ["router.post('/patients/:uhid/photos'", "router.put('/photos/:id/link'", "router.post('/patients/:uhid/capture'",
      "router.get('/capture/:id'", "router.put('/capture/:id'", "router.post('/capture/:id/close'"]) {
      const line = routes.split('\n').find((l) => l.startsWith(r));
      assert.ok(line, r);
      assert.match(line, /authorize\('doctor', PERMISSIONS\.DERM_RECORD\)/, r);
    }
    assert.match(routes, /router\.use\(authenticate, requireModule\('dermatology'\)\)/);
  });
  test('the phone side has no sign-in but is token-limited and module-checked', () => {
    assert.match(app, /app\.use\('\/api\/derm-capture',\s+require\('\.\/routes\/dermCapture'\)\)/);
    assert.doesNotMatch(phone, /authenticate/);
    assert.match(phone, /phoneLimiter/);
    assert.equal((ctl.match(/isModuleOn\('dermatology'\)/g) || []).length >= 2, true);
  });
  test('the phone can only add: bound to the first phone, consent re-checked, no record read', () => {
    assert.match(ctl, /deviceKeyHash/);
    assert.match(ctl, /OTHER_DEVICE/);
    assert.match(ctl, /NO_CONSENT/);
    const open = ctl.slice(ctl.indexOf('const phoneOpen'), ctl.indexOf('const phoneUpload'));
    assert.doesNotMatch(open, /DermObservation|notes|diagnos/i, 'the phone page must not read clinical content');
  });
  test('only the token hash is stored; sessions are the creating doctor\'s', () => {
    assert.match(ctl, /tokenHash: hashToken\(token\)/);
    assert.match(ctl, /s\.doctorId !== req\.user\.id/);
  });
  test('one writer for every photo; attribution from the JWT or the session\'s doctor', () => {
    assert.match(photos, /const storePhoto = async/);
    assert.match(photos, /uploadedById: req\.user\.id/);
    assert.match(ctl, /uploadedById: s\.doctorId/);
  });
  test('the migration guards and refuses a lossy down', () => {
    const m = read('migrations/20260928000027-derm-area-photos-and-capture.js');
    assert.match(m, /describeTable/); assert.match(m, /showAllTables/); assert.match(m, /down refused/);
  });
});
