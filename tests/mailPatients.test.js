const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Staff Email (B26) phase 3a — the pure parts of the patient tie-ins, and the
// guarantee that the inline gate used by services/mailPatients is exactly the
// route gate authorize() applies.

const { gateResult, passesGate, INTERNAL_ROLES } = require('../constants/permissions');
const { authorize } = require('../middleware/auth');
const mailPatients = require('../services/mailPatients');
const { _internals: sendInternals } = require('../services/mailSend');

const { cleanDocIds, documentFile, MAGIC, DOCUMENTS_DIR, yearOf } = mailPatients._internals;

const user = (role, permissions = [], deniedPermissions = []) => ({ id: 7, role, permissions, deniedPermissions });

const viaAuthorize = (u, allow) => {
  let passed = false;
  let status = null;
  authorize(...allow)({ user: u }, { status: (c) => { status = c; return { json: () => {} }; } }, () => { passed = true; });
  return passed ? 'ok' : status;
};

test('gateResult agrees with authorize() for every role and grant/withdrawal', () => {
  const gates = [mailPatients.PATIENT_VIEW, mailPatients.DOCUMENT_VIEW, mailPatients.DOCUMENT_WRITE];
  const people = [];
  for (const role of [...INTERNAL_ROLES, 'patient']) {
    people.push(user(role));
    people.push(user(role, ['documents.write']));
    people.push(user(role, [], ['documents.write']));
    people.push(user(role, ['admin.access']));
  }
  for (const allow of gates) {
    for (const u of people) {
      const r = gateResult(u, allow);
      const a = viaAuthorize(u, allow);
      assert.strictEqual(r === 'ok', a === 'ok', `${u.role} ${JSON.stringify(u.permissions)} ${JSON.stringify(allow)}`);
      assert.strictEqual(passesGate(u, allow), a === 'ok');
    }
  }
});

test('patient suggestions follow the patient-list gate: every internal role, never a patient', () => {
  for (const role of INTERNAL_ROLES) assert.ok(mailPatients.canSeePatients(user(role)), role);
  assert.ok(!mailPatients.canSeePatients(user('patient')));
});

test('saving to a patient file needs the document-upload gate (lab and nurse only with documents.write)', () => {
  assert.ok(passesGate(user('doctor'), mailPatients.DOCUMENT_WRITE));
  assert.ok(passesGate(user('staff'), mailPatients.DOCUMENT_WRITE));
  assert.ok(!passesGate(user('lab'), mailPatients.DOCUMENT_WRITE));
  assert.ok(!passesGate(user('nurse'), mailPatients.DOCUMENT_WRITE));
  assert.ok(passesGate(user('nurse', ['documents.write']), mailPatients.DOCUMENT_WRITE));
  assert.strictEqual(gateResult(user('doctor', [], ['documents.write']), mailPatients.DOCUMENT_WRITE), 'denied');
});

test('cleanDocIds keeps positive unique ids, accepts refs, caps at 20', () => {
  assert.deepStrictEqual(cleanDocIds([3, '3', { documentId: 4 }, -1, 'x', 0, null]), [3, 4]);
  assert.deepStrictEqual(cleanDocIds('3'), []);
  assert.strictEqual(cleanDocIds(Array.from({ length: 40 }, (_, i) => i + 1)).length, 20);
});

test('documentFile never resolves outside uploads/documents', () => {
  assert.strictEqual(documentFile({ filePath: 'uploads/documents/../../.env' }), null);
  assert.strictEqual(documentFile({ filePath: '/etc/passwd' }), null);
  assert.strictEqual(documentFile({ filePath: 'uploads/staff-documents/x.pdf' }), null);
  assert.strictEqual(documentFile({ filePath: '' }), null);
  // A well-formed path to a file that isn't there is also null (not an error).
  assert.strictEqual(documentFile({ filePath: 'uploads/documents/does-not-exist.pdf' }), null);
  assert.ok(DOCUMENTS_DIR.endsWith(path.join('uploads', 'documents')));
});

test('save-to-file accepts PDF, JPEG and PNG by content, not by name', () => {
  const kind = (buf) => (MAGIC.find((m) => m.test(buf)) || {}).type || null;
  assert.strictEqual(kind(Buffer.from('%PDF-1.7\n...')), 'application/pdf');
  assert.strictEqual(kind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.strictEqual(kind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.strictEqual(kind(Buffer.from('MZ\x90\x00 an exe named report.pdf')), null);
  assert.strictEqual(kind(Buffer.from('<html>report</html>')), null);
});

const buildRaw = (extra) => sendInternals.buildRaw({
  from: { name: 'Dr E', address: 'e@cdiabetescentre.com' },
  rcpt: { to: [{ name: '', address: 'x@example.com' }], cc: [], bcc: [] },
  subject: 's', html: '<p>hi</p>', inReplyTo: null, references: [], attachments: [],
  messageId: '<a@b>', date: new Date('2026-09-26T12:00:00Z'), keepBcc: true, ...extra,
}).then((b) => b.toString('utf8'));

test('a draft carries patient documents by reference in a header — a sent message never does', async () => {
  const draft = await buildRaw({ draft: true, patientDocumentIds: [12, 34] });
  assert.match(draft, /^X-HMS-Patient-Documents: 12,34\r?$/im);
  const sent = await buildRaw({ draft: false, patientDocumentIds: [12, 34] });
  assert.doesNotMatch(sent, /X-HMS-Patient-Documents/i);
  const plainDraft = await buildRaw({ draft: true, patientDocumentIds: [] });
  assert.doesNotMatch(plainDraft, /X-HMS-Patient-Documents/i);
});

test('searchPatients ignores queries shorter than two characters (no DB call)', async () => {
  assert.deepStrictEqual(await mailPatients.searchPatients(''), []);
  assert.deepStrictEqual(await mailPatients.searchPatients(' a '), []);
});

test('year of birth from a Date (Patient.dateOfBirth is DATE) or a YYYY-MM-DD string', () => {
  assert.strictEqual(yearOf(new Date('1961-04-02T00:00:00')), '1961');
  assert.strictEqual(yearOf('1978-01-01'), '1978');
  assert.strictEqual(yearOf(null), null);
  assert.strictEqual(yearOf('not a date'), null);
  assert.strictEqual(yearOf(new Date('nope')), null);
});
