// Autosave drafts (6 Oct 2026). Pure: the rules in utils/formDrafts, and the
// controller with the models stubbed — a draft is ALWAYS the caller's own
// (userId from req.user, never the body), reads span the merge family, writes
// go to the canonical patient and refuse a merged-away file. DB behaviour
// (migration up/down, unique index, the sweep) was exercised on the scratch
// MariaDB.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const D = require('../utils/formDrafts');
const db = require('../models');
const family = require('../utils/patientFamily');

const DAY = 24 * 3600 * 1000;

describe('draft rules', () => {
  test('form keys are lower-case words and dashes', () => {
    ['consultation-notes', 'prescription', 'ward-round', 'initial-assessment'].forEach((k) => assert.ok(D.isFormKey(k), k));
    ['', 'X', 'Consultation', 'a b', '../x', 'x'.repeat(70), null, 5].forEach((k) => assert.equal(D.isFormKey(k), false, String(k)));
  });
  test('context is empty or a short id-like value', () => {
    assert.equal(D.cleanContextKey(undefined), '');
    assert.equal(D.cleanContextKey(''), '');
    assert.equal(D.cleanContextKey('adm-12'), 'adm-12');
    assert.equal(D.cleanContextKey('2026-10-06'), '2026-10-06');
    assert.equal(D.cleanContextKey('a/b'), null);
    assert.equal(D.cleanContextKey('x'.repeat(65)), null);
  });
  test('a save needs a payload and stores it as JSON text', () => {
    assert.equal(D.cleanSave({ formKey: 'plan' }).code, 'NO_PAYLOAD');
    assert.equal(D.cleanSave({ formKey: 'plan', payload: null }).code, 'NO_PAYLOAD');
    const ok = D.cleanSave({ formKey: 'plan', payload: { text: 'hi' }, label: '  Plan  ', device: 'iPad' });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.payload, '{"text":"hi"}');
    assert.equal(ok.value.label, 'Plan');
    assert.equal(ok.value.contextKey, '');
  });
  test('an oversized draft is refused (the form keeps its local copy)', () => {
    const big = D.cleanSave({ formKey: 'physical-exam', payload: { img: 'x'.repeat(D.MAX_PAYLOAD_CHARS + 1) } });
    assert.equal(big.ok, false);
    assert.equal(big.code, 'TOO_LARGE');
  });
  test('reminder on day 12, once; deleted from day 14', () => {
    const now = new Date('2026-10-20T08:00:00Z');
    const at = (days) => ({ updatedAt: new Date(now.getTime() - days * DAY), reminderSentAt: null });
    assert.equal(D.needsReminder(at(11.9), now), false);
    assert.equal(D.needsReminder(at(12), now), true);
    assert.equal(D.needsReminder({ ...at(12.5), reminderSentAt: now }, now), false);
    assert.equal(D.needsReminder(at(14), now), false);
    assert.equal(D.isExpired(at(13.9), now), false);
    assert.equal(D.isExpired(at(14), now), true);
  });
  test('payload reads back whether the driver gives text or an object', () => {
    assert.deepEqual(D.readPayload('{"a":1}'), { a: 1 });
    assert.deepEqual(D.readPayload({ a: 1 }), { a: 1 });
    assert.equal(D.readPayload('not json'), null);
  });
  test('list views carry no payload; expiry is 14 days on', () => {
    const row = { id: 3, formKey: 'plan', contextKey: '', label: 'Plan', updatedAt: new Date('2026-10-06T10:00:00Z'), payload: '{"t":1}' };
    const v = D.draftView(row, { withPayload: false });
    assert.equal('payload' in v, false);
    assert.equal(v.expiresAt.toISOString(), '2026-10-20T10:00:00.000Z');
    assert.deepEqual(D.draftView(row).payload, { t: 1 });
  });
});

describe('controller — a draft is only ever its author\'s', () => {
  const calls = [];
  let existing = null;
  const fam = { patient: { id: 10 }, patientIds: [10, 4], isDeactivated: false };
  let C;
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  beforeEach(() => {
    calls.length = 0;
    existing = null;
    family.resolvePatient = async (uhid) => (uhid === 'CDC1' ? fam : uhid === 'OLD' ? { ...fam, isDeactivated: true } : null);
    db.FormDraft.findOne = async (q) => { calls.push(['findOne', q]); return existing; };
    db.FormDraft.findAll = async (q) => { calls.push(['findAll', q]); return []; };
    db.FormDraft.create = async (v) => { calls.push(['create', v]); return { id: 1, ...v, updatedAt: new Date() }; };
    db.FormDraft.destroy = async (q) => { calls.push(['destroy', q]); return 1; };
    delete require.cache[require.resolve('../controllers/formDraftController')];
    C = require('../controllers/formDraftController');
  });

  test('save stamps the author from the token, never the body, on the canonical patient', async () => {
    const r = res();
    await C.save({ user: { id: 7 }, body: { uhid: 'CDC1', formKey: 'consultation-notes', payload: { t: 'x' }, userId: 99, PatientId: 4 } }, r);
    assert.equal(r.statusCode, 200);
    const created = calls.find(([k]) => k === 'create')[1];
    assert.equal(created.userId, 7);
    assert.equal(created.PatientId, 10);
    assert.equal(created.reminderSentAt, null);
    const lookup = calls.find(([k]) => k === 'findOne')[1].where;
    assert.equal(lookup.userId, 7);
    assert.deepEqual(lookup.PatientId, { [Op.in]: [10, 4] });
  });

  test('saving again replaces the existing draft and clears its reminder', async () => {
    let updated = null;
    existing = { id: 5, updatedAt: new Date(), update: async (v) => { updated = v; } };
    await C.save({ user: { id: 7 }, body: { uhid: 'CDC1', formKey: 'plan', payload: 'a' } }, res());
    assert.equal(calls.some(([k]) => k === 'create'), false);
    assert.equal(updated.reminderSentAt, null);
    assert.equal(updated.PatientId, 10);
  });

  test('a merged-away file refuses new drafts; an unknown one is 404', async () => {
    const r1 = res();
    await C.save({ user: { id: 7 }, body: { uhid: 'OLD', formKey: 'plan', payload: 'a' } }, r1);
    assert.equal(r1.statusCode, 403);
    const r2 = res();
    await C.save({ user: { id: 7 }, body: { uhid: 'NOPE', formKey: 'plan', payload: 'a' } }, r2);
    assert.equal(r2.statusCode, 404);
    assert.equal(calls.some(([k]) => k === 'create'), false);
  });

  test('reading a patient\'s drafts is scoped to the caller and the merge family', async () => {
    await C.listForPatient({ user: { id: 7 }, query: { uhid: 'CDC1' } }, res());
    const where = calls.find(([k]) => k === 'findAll')[1].where;
    assert.equal(where.userId, 7);
    assert.deepEqual(where.PatientId, { [Op.in]: [10, 4] });
    assert.ok(where.updatedAt[Op.gt] instanceof Date, 'expired drafts are never returned');
  });

  test('discarding only ever touches the caller\'s own drafts', async () => {
    await C.remove({ user: { id: 7 }, query: { uhid: 'CDC1', formKey: 'plan' } }, res());
    await C.removeById({ user: { id: 7 }, params: { id: '12' } }, res());
    const [a, b] = calls.filter(([k]) => k === 'destroy').map(([, q]) => q.where);
    assert.equal(a.userId, 7);
    assert.equal(a.contextKey, '');
    assert.deepEqual(b, { id: 12, userId: 7 });
  });

  test('a bad form key is refused before any write', async () => {
    const r = res();
    await C.save({ user: { id: 7 }, body: { uhid: 'CDC1', formKey: '../etc', payload: 'a' } }, r);
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.code, 'BAD_FORM_KEY');
  });
});

describe('routing', () => {
  test('drafts are mounted before the per-IP general limiter (shared clinic IP)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../app.js'), 'utf8');
    const drafts = src.indexOf("app.use('/api/drafts'");
    const limiter = src.indexOf("app.use('/api/', generalLimiter)");
    assert.ok(drafts > 0 && limiter > 0 && drafts < limiter);
  });
});
