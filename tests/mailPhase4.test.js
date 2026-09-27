const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Staff Email (B26) phase 4 — "Email this patient". The parts that need no
// database or mailbox: the patient_emailed detail (subject kept, capped, always
// fits the column), UHID cleaning, the Activity Log type + filter group, and
// source-level guard-rails (the subject never reaches the Activity Log; the
// patient-recipient header is written on drafts only). Tagged-chip
// verification against a real patient file, the trail and the draft round
// trip are proven by the scratch-DB + Dovecot end-to-end run (session doc).

const mailPatients = require('../services/mailPatients');
const { MAIL_EVENT_TYPES, ACTION_GROUPS } = require('../controllers/activityController');

const { emailedDetail, cleanUhids, SUBJECT_KEEP, DETAIL_MAX } = mailPatients._internals;
const summary = { count: 2, domains: ['gmail.com', 'cdiabetescentre.com'] };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('patient_emailed detail', () => {
  test('keeps the subject, the file documents and the counts', () => {
    const d = JSON.parse(emailedDetail({ subject: 'Your HbA1c result', documentIds: [4, 9], summary, otherAttachments: 1 }));
    assert.equal(d.subject, 'Your HbA1c result');
    assert.deepEqual(d.documents, [4, 9]);
    assert.equal(d.recipients, 2);
    assert.deepEqual(d.domains, ['gmail.com', 'cdiabetescentre.com']);
    assert.equal(d.attachments, 1);
  });

  test('never stores an address or a body', () => {
    const raw = emailedDetail({ subject: 'Letter', documentIds: [], summary, otherAttachments: 0 });
    assert.doesNotMatch(raw, /@/);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['attachments', 'documents', 'domains', 'recipients', 'subject']);
  });

  test(`subject capped at ${SUBJECT_KEEP} characters with an ellipsis`, () => {
    const d = JSON.parse(emailedDetail({ subject: 'x'.repeat(400), documentIds: [], summary }));
    assert.equal(d.subject.length, SUBJECT_KEEP);
    assert.ok(d.subject.endsWith('…'));
  });

  test('line breaks in a subject are flattened', () => {
    assert.equal(JSON.parse(emailedDetail({ subject: 'A\r\nB', summary })).subject, 'A B');
  });

  test(`always fits the ${DETAIL_MAX}-character column — even a subject of quotes and 20 documents`, () => {
    const raw = emailedDetail({ subject: '"\\'.repeat(150), documentIds: Array.from({ length: 30 }, (_, i) => 100000 + i), summary: { count: 50, domains: ['a-very-long-domain-name.example.co.ke', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example'] }, otherAttachments: 20 });
    assert.ok(raw.length <= DETAIL_MAX, `${raw.length}`);
    const d = JSON.parse(raw);
    assert.equal(d.documents.length, 20);
    assert.equal(d.domains.length, 5);
  });

  test('an empty subject is kept as empty, not dropped', () => {
    assert.equal(JSON.parse(emailedDetail({ subject: '', summary })).subject, '');
  });
});

describe('patient recipient UHIDs', () => {
  test('trimmed, de-duplicated, blanks dropped, at most 20', () => {
    assert.deepEqual(cleanUhids([' CDC-1 ', 'CDC-1', '', null, { uhid: 'CDC-2' }]), ['CDC-1', 'CDC-2']);
    assert.equal(cleanUhids(Array.from({ length: 30 }, (_, i) => `CDC-${i}`)).length, 20);
    assert.deepEqual(cleanUhids('CDC-1'), []);
    assert.deepEqual(cleanUhids(['x'.repeat(51)]), []);
  });

  test('no UHIDs → nothing to verify (and no database touched)', async () => {
    assert.deepEqual(await mailPatients.verifyPatientRecipients({ id: 1, role: 'doctor' }, [], { to: [] }), []);
  });

  test('a role that cannot open patient files gets nothing logged', async () => {
    assert.deepEqual(await mailPatients.verifyPatientRecipients({ id: 1, role: 'patient' }, ['CDC-1'], { to: [{ address: 'a@b.c' }] }), []);
  });
});

describe('Activity Log', () => {
  test('patient_emailed has its own type and label', () => {
    assert.deepEqual(MAIL_EVENT_TYPES.patient_emailed, { type: 'mail_patient_emailed', label: 'Emailed Patient' });
  });

  test('it is in "all mail" and in the patient-documents filter', () => {
    assert.ok(ACTION_GROUPS.mail_all.includes('mail_patient_emailed'));
    assert.ok(ACTION_GROUPS.mail_patient_docs.includes('mail_patient_emailed'));
  });

  test('the Activity Log never reads the subject', () => {
    const src = read('controllers/activityController.js');
    assert.doesNotMatch(src, /\.subject\b/);
  });

  test('the frontend Activity Log knows the new type (label + style)', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'pages', 'admin');
    if (!fs.existsSync(fe)) return;   // backend-only checkout
    assert.match(fs.readFileSync(path.join(fe, 'ActivityLog.jsx'), 'utf8'), /mail_patient_emailed/);
    assert.match(fs.readFileSync(path.join(fe, 'activityLogShared.js'), 'utf8'), /mail_patient_emailed/);
  });
});

describe('guard-rails', () => {
  test('the model ENUM and the migration list the same events', () => {
    const mig = require('../migrations/20260926000004-staff-mail-patient-emailed.js');
    assert.equal(typeof mig.up, 'function');
    assert.equal(typeof mig.down, 'function');
    const migSrc = read('migrations/20260926000004-staff-mail-patient-emailed.js');
    const model = read('models/StaffMailEvent.js');
    const modelEvents = model.match(/ENUM\(([^)]*)\)/)[1].split(',').map((v) => v.trim().replace(/'/g, ''));
    assert.ok(modelEvents.includes('patient_emailed'));
    // The model follows the NEWEST migration that widens the ENUM (phase 5 adds two).
    const latest = read('migrations/20260926000005-patient-email-threads.js');
    for (const e of modelEvents) assert.match(latest, new RegExp(`'${e}'`));
    assert.match(migSrc, /'patient_emailed'/);
    assert.match(migSrc, /bulkDelete\(TABLE, \{ event: 'patient_emailed' \}\)/);
  });

  test('the patient-recipient header is written on drafts only', () => {
    const src = read('services/mailSend.js');
    assert.match(src, /if \(draft && patientUhids && patientUhids\.length\) headers\['X-HMS-Patient-Recipients'\]/);
    assert.equal((src.match(/X-HMS-Patient-Recipients/g) || []).length, 1);
  });

  test('a send never waits on logging to decide whether it goes: verification happens before SMTP, logging after', () => {
    const src = read('services/mailSend.js');
    const body = src.slice(src.indexOf('const send = async'), src.indexOf('const saveDraft'));
    const verify = body.indexOf('verifyPatientRecipients');
    const smtp = body.indexOf('transport.sendMail');
    const log = body.indexOf('logPatientEmailed');
    assert.ok(verify > 0 && verify < smtp && smtp < log);
  });

  test('the Communications trail reads mail events merge-aware, for the email-side events only', () => {
    const src = read('services/mailPatients.js');
    const fn = src.slice(src.indexOf('const patientEmailTrail'), src.indexOf('// ---- 3. save an attachment'));
    assert.match(fn, /patientId: \{ \[Op\.in\]: family\.patientIds \}/);
    assert.match(src, /const TRAIL_EVENTS = \['patient_emailed', 'patient_docs_sent', 'saved_to_patient'\]/);
  });
});
