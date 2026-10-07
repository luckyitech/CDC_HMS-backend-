// Remote requests (6 Oct 2026) — a prescription / lab request written outside
// a consultation. Pure: the rules in utils/remoteRequests, and the controller
// with the models stubbed (the author is always req.user; writes go to the
// canonical patient; a merged-away file is refused). The link from a
// prescription / lab request, the migration and the Visit History read were
// exercised on the scratch MariaDB.
const { test, describe, beforeEach } = require('node:test');
const { Op } = require('sequelize');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../utils/remoteRequests');
const db = require('../models');
const family = require('../utils/patientFamily');

describe('what a remote request needs', () => {
  const ok = { channel: 'phone', requestedByType: 'patient', note: 'Out of metformin, stable.' };
  test('channel, who asked and a clinical note', () => {
    assert.equal(R.cleanRequest(ok).ok, true);
    assert.equal(R.cleanRequest({ ...ok, channel: 'sms' }).code, 'BAD_CHANNEL');
    assert.equal(R.cleanRequest({ ...ok, requestedByType: 'neighbour' }).code, 'BAD_ASKER');
    assert.equal(R.cleanRequest({ ...ok, note: '   ' }).code, 'NOTE_REQUIRED');
  });
  test('a relative or a pharmacy must be named; the patient need not be', () => {
    assert.equal(R.cleanRequest({ ...ok, requestedByType: 'relative' }).code, 'NAME_REQUIRED');
    assert.equal(R.cleanRequest({ ...ok, requestedByType: 'pharmacy', requestedByName: ' ' }).code, 'NAME_REQUIRED');
    const v = R.cleanRequest({ ...ok, requestedByType: 'relative', requestedByName: ' Daughter — Mercy ' }).value;
    assert.equal(v.requestedByName, 'Daughter — Mercy');
    assert.equal(R.cleanRequest(ok).value.requestedByName, null);
  });
  test('the summary line names the channel and who asked', () => {
    assert.equal(R.summaryLine({ channel: 'whatsapp', requestedByType: 'relative', requestedByName: 'Daughter — Mercy' }), 'WhatsApp · Daughter — Mercy');
    assert.equal(R.summaryLine({ channel: 'walk_in', requestedByType: 'patient' }), 'Walk-in, no visit · the patient');
  });
});

describe('who may attach an order to a remote request', () => {
  const rr = { id: 4, doctorId: 7, PatientId: 10, status: 'active' };
  const ctx = { userId: 7, patientIds: [10, 3], today: '2026-10-06', rrDay: '2026-10-06' };
  test('its author, same patient family, same day, while active', () => {
    assert.equal(R.linkRefusal(rr, ctx), null);
    assert.equal(R.linkRefusal({ ...rr, PatientId: 3 }, ctx), null, 'a merged-in file is the same patient');
  });
  test('anyone else, another patient, a cancelled or an old request is refused', () => {
    assert.equal(R.linkRefusal(null, ctx).code, 'NO_REMOTE_REQUEST');
    assert.equal(R.linkRefusal(rr, { ...ctx, userId: 8 }).code, 'NOT_AUTHOR');
    assert.equal(R.linkRefusal({ ...rr, PatientId: 99 }, ctx).code, 'OTHER_PATIENT');
    assert.equal(R.linkRefusal({ ...rr, status: 'cancelled' }, ctx).code, 'CANCELLED');
    assert.equal(R.linkRefusal(rr, { ...ctx, rrDay: '2026-10-05' }).code, 'OLD_REQUEST');
  });
});

describe('controller', () => {
  const calls = [];
  const fam = { patient: { id: 10 }, patientIds: [10, 3], isDeactivated: false };
  let C;
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  beforeEach(() => {
    calls.length = 0;
    family.resolvePatient = async (u) => (u === 'CDC1' ? fam : u === 'OLD' ? { ...fam, isDeactivated: true } : null);
    db.RemoteRequest.create = async (v) => { calls.push(['create', v]); return { id: 1, ...v }; };
    db.RemoteRequest.findByPk = async () => ({ id: 1, doctorId: 7, status: 'active', update: async (v) => calls.push(['update', v]) });
    db.RemoteRequest.findAll = async (q) => { calls.push(['findAll', q]); return []; };
    delete require.cache[require.resolve('../controllers/remoteRequestController')];
    C = require('../controllers/remoteRequestController');
  });
  test('the author comes from the token and the row goes to the canonical patient', async () => {
    const r = res();
    await C.create({ user: { id: 7 }, body: { uhid: 'CDC1', channel: 'phone', requestedByType: 'patient', note: 'x', doctorId: 99, PatientId: 3, status: 'cancelled' } }, r);
    assert.equal(r.statusCode, 201);
    const v = calls.find(([k]) => k === 'create')[1];
    assert.equal(v.doctorId, 7);
    assert.equal(v.PatientId, 10);
    assert.equal(v.status, 'active');
  });
  test('a merged-away file is refused; no note is refused before any write', async () => {
    const r1 = res();
    await C.create({ user: { id: 7 }, body: { uhid: 'OLD', channel: 'phone', requestedByType: 'patient', note: 'x' } }, r1);
    assert.equal(r1.statusCode, 403);
    const r2 = res();
    await C.create({ user: { id: 7 }, body: { uhid: 'CDC1', channel: 'phone', requestedByType: 'patient', note: '' } }, r2);
    assert.equal(r2.body.code, 'NOTE_REQUIRED');
    assert.equal(calls.some(([k]) => k === 'create'), false);
  });
  test('only the author may cancel, and cancelling keeps the row', async () => {
    const r1 = res();
    await C.cancel({ user: { id: 8 }, params: { id: '1' } }, r1);
    assert.equal(r1.statusCode, 403);
    await C.cancel({ user: { id: 7 }, params: { id: '1' } }, res());
    const upd = calls.find(([k]) => k === 'update')[1];
    assert.equal(upd.status, 'cancelled');
    assert.equal(upd.cancelledById, 7);
  });
  test('reading spans the merge family', async () => {
    await C.listForPatient({ user: { id: 7 }, query: { uhid: 'CDC1' } }, res());
    assert.deepEqual(calls.find(([k]) => k === 'findAll')[1].where.PatientId[Op.in], [10, 3]);
  });
});

describe('wiring', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  test('prescriptions and lab requests both use the one link check', () => {
    assert.match(read('controllers/prescriptionController.js'), /checkLink\(/);
    assert.match(read('controllers/labTestController.js'), /checkLink\(/);
  });
  test('writing a remote request is for doctors only', () => {
    const src = read('routes/remoteRequests.js');
    assert.match(src, /router\.post\('\/', authenticate, authorize\('doctor'\)/);
    assert.match(src, /router\.patch\('\/:id\/cancel', authenticate, authorize\('doctor'\)/);
  });
  test('a prescription edit can never re-point its remote request or author', () => {
    const src = read('controllers/prescriptionController.js');
    assert.match(src, /remoteRequestId: _r/);
    assert.match(src, /doctorId: _d/);
  });
});
