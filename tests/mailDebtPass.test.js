const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Staff Email (B26) debt pass, 27 Sep — the parts that need no mailbox or DB:
// subject entity decoding, folder-name rules, report-copy wiring, the route
// shapes, and that report PDFs never ride along into a draft. The IMAP and DB
// behaviour (folders, select-all, fuzzy search, report copies) is proven by the
// Dovecot + MariaDB end-to-end run (see the session doc).

const { displaySubject, decodeEntities } = require('../utils/mailRender');
const organise = require('../services/mailOrganise');
const mailPatients = require('../services/mailPatients');
const { DOCUMENT_CATEGORIES, PDF_ONLY_CATEGORIES } = require('../utils/medicalDocumentCreate');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('subjects are decoded for display', () => {
  test('named and numeric entities become the real character', () => {
    assert.equal(displaySubject('OEM inquiry &mdash; in stock'), 'OEM inquiry — in stock');
    assert.equal(displaySubject('Tom &amp; Jerry &#8212; &#x2014;'), 'Tom & Jerry — —');
    assert.equal(displaySubject('Caf&eacute; &hellip;'), 'Café …');
  });
  test('unknown or invalid entities are left exactly as they were', () => {
    assert.equal(decodeEntities('&bogus; &#0; &#xD800; & alone'), '&bogus; &#0; &#xD800; & alone');
  });
  test('the result is text, never markup (React escapes it)', () => {
    assert.equal(displaySubject('&lt;script&gt;'), '<script>');
  });
  test('empty and missing subjects stay empty', () => {
    assert.equal(displaySubject(null), '');
    assert.equal(displaySubject(''), '');
  });
  test('every place a subject is shaped for display uses it', () => {
    assert.equal((read('services/mailSession.js').match(/subject: displaySubject\(env\.subject\)/g) || []).length, 2);
    assert.match(read('services/mailWatch.js'), /subject: displaySubject\(env\.subject\)/);
    assert.match(read('services/mailThreads.js'), /subject: displaySubject\(r\.subject\)/);
  });
});

describe('folder names', () => {
  const ok = (n) => organise.cleanFolderName(n, '/');
  const bad = (n, re) => assert.throws(() => organise.cleanFolderName(n, '.'), (e) => e.code === 'BAD_NAME' && (!re || re.test(e.message)));
  test('trimmed and collapsed (tabs too)', () => { assert.equal(ok('  Insurers \t  2026 '), 'Insurers 2026'); });
  test('empty, too long, or with a path character is refused', () => {
    bad('   ');
    bad('x'.repeat(61), /60/);
    bad('a/b'); bad('a\\b'); bad('50%'); bad('a*'); bad('Dept.Admin');   // "." is this server's delimiter
    bad('bell\u0007');
  });
  test("the mailbox's own folder names are refused, any case", () => {
    for (const n of ['Inbox', 'INBOX', 'Sent', 'sent items', 'Drafts', 'Trash', 'Deleted Items', 'Junk', 'Spam', 'Archive']) bad(n, /kept for/);
  });
});

describe('folders and select-all — shape', () => {
  test('folder routes: own lines, own mailbox, each a single-quoted path (D1 scan)', () => {
    const routes = read('routes/mail.js');
    assert.match(routes, /^router\.post\('\/folders', authenticate, authorize\(\.\.\.MAIL\)/m);
    assert.match(routes, /^router\.post\('\/folders\/rename', authenticate, authorize\(\.\.\.MAIL\)/m);
    assert.match(routes, /^router\.post\('\/folders\/delete', authenticate, authorize\(\.\.\.MAIL\)/m);
    assert.doesNotMatch(routes, /\/folders[^']*:userId/);
  });
  test('deleting a folder is only ever mailboxDelete behind the empty check, and messageDelete stays in emptyTrash', () => {
    const src = read('services/mailOrganise.js');
    assert.equal((src.match(/mailboxDelete\(/g) || []).length, 1);
    const del = src.slice(src.indexOf('const deleteFolder'), src.indexOf('async function releaseIfSelected'));
    assert.ok(del.indexOf("search({ all: true }") < del.indexOf('mailboxDelete('), 'emptiness is checked on the server first');
    assert.match(del, /FOLDER_NOT_EMPTY/);
    assert.equal((src.match(/messageDelete\(/g) || []).length, 1);
  });
  test('select-all re-finds UIDs up to uidMax and counts newer mail separately', () => {
    const src = read('services/mailOrganise.js');
    assert.match(src, /uid: `1:\$\{uidMax\}`/);
    assert.match(src, /uid: `\$\{uidMax \+ 1\}:\*`/);
    assert.match(src, /FOLDER_CHANGED/);
  });
  test("the list's uidMax is the newest message's real UID, never the stale uidNext (caught live 27 Sep)", () => {
    const src = read('services/mailSession.js');
    const list = src.slice(src.indexOf('const listMessages'), src.indexOf('const cleanUid ='));
    assert.match(list, /fetchOne\('\*', \{ uid: true \}\)/);
    assert.doesNotMatch(list.replace(/\/\/.*$/gm, ''), /uidNext/);
  });
  test('resolveAll refuses a missing uidMax before touching the mailbox', async () => {
    await assert.rejects(organise.resolveAll(1, 'INBOX', {}), (e) => e.code === 'BAD_UID');
    await assert.rejects(organise.resolveAll(1, 'INBOX', { uidMax: 0 }), (e) => e.code === 'BAD_UID');
  });
  test('organiseAll rejects an unknown action', () => {
    assert.throws(() => organise.organiseAll('explode', 1, { all: { uidMax: 5 } }), (e) => e.code === 'BAD_ACTION');
  });
});

describe('emailed HMS reports — the copy on the file', () => {
  test('"Sent Correspondence" is an official category and takes PDFs', () => {
    assert.ok(DOCUMENT_CATEGORIES.includes(mailPatients.REPORT_CATEGORY));
    assert.equal(mailPatients.REPORT_CATEGORY, 'Sent Correspondence');
    assert.ok(!PDF_ONLY_CATEGORIES.includes('Sent Correspondence'));
  });
  test('the frontend category list matches the backend one', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'contexts', 'PatientContext.jsx');
    if (!fs.existsSync(fe)) return;   // backend-only checkout
    for (const c of DOCUMENT_CATEGORIES) assert.ok(fs.readFileSync(fe, 'utf8').includes(`"${c}"`), c);
  });
  test('no reports → nothing to check (and no permission needed)', async () => {
    assert.deepEqual(await mailPatients.checkReportCopies({ id: 1, role: 'lab' }, [], []), []);
    assert.deepEqual(await mailPatients.checkReportCopies({ id: 1, role: 'lab' }, undefined, []), []);
  });
  test('a report needs the document-write permission', async () => {
    await assert.rejects(
      mailPatients.checkReportCopies({ id: 1, role: 'lab', permissions: [] }, [{ uhid: 'X', filename: 'a.pdf' }], []),
      (e) => e.code === 'FORBIDDEN',
    );
  });
  test('a report must be one of the uploaded files, and a real PDF', async () => {
    const doctor = { id: 1, role: 'doctor' };
    await assert.rejects(mailPatients.checkReportCopies(doctor, [{ uhid: 'X', filename: 'a.pdf' }], []), (e) => e.code === 'ATTACH_GONE');
    await assert.rejects(
      mailPatients.checkReportCopies(doctor, [{ uhid: 'X', filename: 'a.pdf' }], [{ originalname: 'a.pdf', buffer: Buffer.from('not a pdf') }]),
      (e) => e.code === 'BAD_TYPE',
    );
  });
  test('at most 10 reports per email', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ uhid: 'X', filename: `${i}.pdf` }));
    await assert.rejects(mailPatients.checkReportCopies({ id: 1, role: 'doctor' }, many, []), (e) => e.code === 'TOO_MANY');
  });
  test('send checks the reports BEFORE anything leaves, files them only after, and never parks them in a draft', () => {
    const src = read('services/mailSend.js');
    const send = src.slice(src.indexOf('const send = async'), src.indexOf('const signaturePreview'));
    assert.ok(send.indexOf('checkReportCopies') < send.indexOf('sendMail('), 'checked before SMTP');
    assert.ok(send.indexOf('saveReportCopies') > send.indexOf("It has gone"), 'filed only after the send');
    const draft = src.slice(src.indexOf('const saveDraft = async'));
    assert.match(draft, /reportNames/);
    assert.match(draft, /gatherAttachments\(userId, payload\.attachments, draftFiles\)/);
  });
  test('a filed report is not listed again as an unfiled attachment on the thread', () => {
    const src = read('services/mailSend.js');
    assert.match(src, /attachmentNames: dropFiled\(mailAttachments\.map\(\(a\) => a\.filename\), filedReportNames\)/);
  });
  test('the copy is Reviewed, dated today, and attributed from the JWT user', () => {
    const src = read('services/mailPatients.js');
    const save = src.slice(src.indexOf('const saveReportCopies'), src.indexOf('// ---- 3. save an attachment'));
    assert.match(save, /status: 'Reviewed'/);
    assert.match(save, /actingUser: user/);
    assert.match(save, /documentCategory: REPORT_CATEGORY/);
  });
});

describe('fuzzy patient search in Mail', () => {
  test('uses the shared B25 matcher and keeps exact hits first', () => {
    const src = read('services/mailPatients.js');
    assert.match(src, /require\('\.\.\/utils\/patientMatch'\)/);
    const fn = src.slice(src.indexOf('const searchPatients'), src.indexOf('// ---- 1. recipient suggestions'));
    assert.ok(fn.indexOf('Patient.findAll') < fn.indexOf('findMatches'), 'LIKE first');
    assert.match(fn, /order\.length < limit/);
    assert.match(fn, /fuzzy: true/);
  });
  test('a phone, email or UHID fragment never triggers the fuzzy fallback', () => {
    const src = read('services/mailPatients.js');
    const line = src.split('\n').find((l) => l.startsWith('const isNameLike'));
    // eslint-disable-next-line no-new-func
    const isNameLike = new Function(`${line}; return isNameLike;`)();
    assert.equal(isNameLike('0712 345'), false);
    assert.equal(isNameLike('amina@'), false);
    assert.equal(isNameLike('CDC-00'), false);
    assert.equal(isNameLike('Mohamed'), true);
    assert.equal(isNameLike('ab'), false);
  });
});
