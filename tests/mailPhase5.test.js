const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Staff Email (B26) phase 5 — patient email threads, all-mail activity,
// email analytics. The parts that need no database or mailbox: thread keys,
// synthetic ids, the analytics maths, the gates, and source-level guard-rails
// (never a hard delete of a patient email; the checker is read-only and logs in
// only through openForUser; the traffic log and analytics never read a subject
// or text). Storage, linking, the 5-minute checker and the trail are proven by
// the scratch-DB + Dovecot end-to-end run (session doc).

const threads = require('../services/mailThreads');
const analytics = require('../services/mailAnalytics');
const { PERMISSIONS, gateResult, ADMIN_ACCESS_COVERS } = require('../constants/permissions');
const { MAIL_EVENT_TYPES, MAIL_TRAFFIC_TYPES, ACTION_GROUPS } = require('../controllers/activityController');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { threadKeyOf, syntheticId, idList } = threads._internals;

describe('threads', () => {
  test('thread key = the first id the message references, else In-Reply-To, else itself', () => {
    assert.equal(threadKeyOf({ messageId: '<c@x>', references: '<a@x> <b@x>', inReplyTo: '<b@x>' }), '<a@x>');
    assert.equal(threadKeyOf({ messageId: '<c@x>', references: '', inReplyTo: '<b@x>' }), '<b@x>');
    assert.equal(threadKeyOf({ messageId: '<c@x>' }), '<c@x>');
  });

  test('a message with no Message-ID gets a stable, unique stand-in', () => {
    const a = syntheticId(4, 'INBOX', 77, 12);
    assert.equal(a, syntheticId(4, 'INBOX', 77, 12));
    assert.notEqual(a, syntheticId(4, 'INBOX', 77, 13));
    assert.notEqual(a, syntheticId(5, 'INBOX', 77, 12));
    assert.match(a, /^<.+@no-message-id>$/);
  });

  test('id lists are de-duplicated across headers', () => {
    assert.deepEqual(idList('<a@x>', '<a@x> <b@x>', ['<c@x>']), ['<a@x>', '<b@x>', '<c@x>']);
  });

  test('linking uses the comms.write list (the WhatsApp "link to patient" capability)', () => {
    assert.deepEqual(threads.LINK_GATE, ['staff', 'doctor', 'nurse', 'admin', 'comms.write']);
    assert.equal(gateResult({ id: 1, role: 'lab' }, threads.LINK_GATE), 'no');
    assert.equal(gateResult({ id: 1, role: 'lab', permissions: ['comms.write'] }, threads.LINK_GATE), 'ok');
  });
});

describe('the patientemail.view permission', () => {
  const GATE = ['doctor', 'nurse', 'admin', 'patientemail.view'];
  test('exists and is covered by admin.access (the route lists admin)', () => {
    assert.equal(PERMISSIONS.PATIENT_EMAIL_VIEW, 'patientemail.view');
    assert.ok(ADMIN_ACCESS_COVERS.includes('patientemail.view'));
  });
  test('doctors and nurses by role; reception only by grant; withdrawable', () => {
    assert.equal(gateResult({ id: 1, role: 'doctor' }, GATE), 'ok');
    assert.equal(gateResult({ id: 1, role: 'nurse' }, GATE), 'ok');
    assert.notEqual(gateResult({ id: 1, role: 'staff' }, GATE), 'ok');
    assert.equal(gateResult({ id: 1, role: 'staff', permissions: ['patientemail.view'] }, GATE), 'ok');
    assert.notEqual(gateResult({ id: 1, role: 'doctor', deniedPermissions: ['patientemail.view'] }, GATE), 'ok');
  });
  test('routes: threads gated by it, removal admin-only, email analytics = the Activity Log gate', () => {
    const src = read('routes/comms.js');
    assert.match(src, /const PATIENT_EMAIL_VIEW = \['doctor', 'nurse', 'admin', 'patientemail\.view'\];/);
    assert.match(src, /router\.get\('\/patients\/:uhid\/email-threads', authenticate, authorize\(\.\.\.PATIENT_EMAIL_VIEW\)/);
    assert.match(src, /router\.post\('\/patients\/:uhid\/email-messages\/:id\/remove', authenticate, authorize\('admin'\)/);
    assert.match(src, /router\.get\('\/analytics\/email', +authenticate, authorize\('admin', 'monitoring\.view'\)/);
  });
  test('the trail controller uses the same list to decide whether a subject is shown', () => {
    assert.match(read('controllers/commsController.js'), /const PATIENT_EMAIL_VIEW = \['doctor', 'nurse', 'admin', 'patientemail\.view'\];/);
  });
  test('frontend mirror', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'utils', 'permissions.js');
    if (!fs.existsSync(fe)) return;
    const s = fs.readFileSync(fe, 'utf8');
    assert.match(s, /PATIENT_EMAIL_VIEW: 'patientemail\.view'/);
    assert.match(s, /PATIENT_EMAIL_DEFAULT_ROLES = \['doctor', 'nurse', 'admin'\]/);
  });
});

describe('analytics maths', () => {
  test('quantile interpolates; empty → null', () => {
    const { quantile } = analytics._internals;
    assert.equal(quantile([], 0.5), null);
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantile([10], 0.9), 10);
  });
  test('range defaults to the last 30 days', () => {
    const { rangeOf } = analytics._internals;
    const { start, end } = rangeOf({});
    const days = (end - start) / 86400000;
    assert.ok(days > 29.9 && days < 30.1, String(days));
  });
});

describe('Activity Log', () => {
  test('every message sent elsewhere / received has a type, in "all email"', () => {
    assert.deepEqual(MAIL_TRAFFIC_TYPES.in, { type: 'mail_received', label: 'Email Received' });
    assert.deepEqual(MAIL_TRAFFIC_TYPES.out, { type: 'mail_sent_elsewhere', label: 'Sent Email (outside the HMS)' });
    assert.ok(ACTION_GROUPS.mail_all.includes('mail_received'));
    assert.ok(ACTION_GROUPS.mail_all.includes('mail_sent_elsewhere'));
  });
  test('linking + admin removal are audited', () => {
    assert.equal(MAIL_EVENT_TYPES.linked_to_patient.type, 'mail_linked_to_patient');
    assert.equal(MAIL_EVENT_TYPES.patient_email_removed.type, 'mail_patient_email_removed');
  });
  test('the frontend knows every new type (label + style)', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'pages', 'admin');
    if (!fs.existsSync(fe)) return;
    const log = fs.readFileSync(path.join(fe, 'ActivityLog.jsx'), 'utf8');
    const style = fs.readFileSync(path.join(fe, 'activityLogShared.js'), 'utf8');
    for (const t of ['mail_received', 'mail_sent_elsewhere', 'mail_linked_to_patient', 'mail_patient_email_removed']) {
      assert.match(log, new RegExp(`'${t}'`)); assert.match(style, new RegExp(`${t}:`));
    }
  });
});

describe('phase 5b — attachments go to the patient’s Documents', () => {
  test('stored attachments: old plain names still read; new ones keep part/type and the Document they became', () => {
    const list = threads.attachmentsOf({ attachmentNames: JSON.stringify(['old.pdf', { filename: 'lab.pdf', part: '2', type: 'application/pdf', size: 10 }, { name: 'x.png', documentId: 7 }]) });
    assert.deepEqual(list[0], { name: 'old.pdf' });
    assert.equal(list[1].name, 'lab.pdf'); assert.equal(list[1].part, '2'); assert.equal(list[1].documentId, null);
    assert.equal(list[2].documentId, 7);
  });
  test('saving is route-gated like POST /api/documents, and only the mailbox owner may do it', () => {
    assert.match(read('routes/comms.js'), /router\.post\('\/patients\/:uhid\/email-messages\/:id\/attachments\/:index\/save', authenticate, authorize\('doctor', 'staff', 'admin', 'documents\.write'\)/);
    const src = read('services/mailThreads.js');
    assert.match(src, /if \(row\.mailboxUserId !== user\.id\)[\s\S]{0,200}NOT_OWNER/);
    // It reuses the ONE save path (gate, byte check, Pending Review, audit).
    assert.match(src, /require\('\.\/mailPatients'\)\.saveAttachmentToPatient\(user,/);
  });
  test('saving an attachment marks it on the thread; the Communications tab never streams a file itself', () => {
    assert.match(read('services/mailPatients.js'), /e\.documentId = document\.id/);
    const fe = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'components', 'shared', 'PatientCommunicationsTab.jsx');
    if (!fs.existsSync(fe)) return;
    const tab = fs.readFileSync(fe, 'utf8');
    assert.doesNotMatch(tab, /getMedia\(|mailService\.attachment\(/, 'attachments open only from Documents (the viewer)');
  });
});

describe('guard-rails', () => {
  test('a patient email is never hard-deleted', () => {
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'services')).concat(fs.readdirSync(path.join(__dirname, '..', 'controllers')))) {
      const rel = fs.existsSync(path.join(__dirname, '..', 'services', f)) ? `services/${f}` : `controllers/${f}`;
      assert.doesNotMatch(read(rel), /PatientEmailMessage\.destroy|PatientEmailMessage[\s\S]{0,40}\.destroy\(/, rel);
    }
    assert.match(read('services/mailThreads.js'), /status: 'removed', removedById: user\.id, removedAt: new Date\(\), removedReason: why/);
  });
  test('the checker logs in only through openForUser, reads folders read-only, changes no flag', () => {
    const src = read('services/mailSync.js');
    assert.match(src, /session\.openForUser\(userId/);
    assert.doesNotMatch(src, /openImap|new ImapFlow/);
    assert.match(src, /getMailboxLock\(path, \{ readOnly: true \}\)/);
    assert.doesNotMatch(src, /messageFlags(Add|Set|Remove)|messageDelete|messageMove/);
    assert.doesNotMatch(read('services/mailThreads.js'), /messageFlags(Add|Set|Remove)|messageDelete|messageMove/);
  });
  test('no text is downloaded while a FETCH is still streaming (imapflow would wait forever)', () => {
    // The body of each `for await (… client.fetch(…))` loop, found by brace matching.
    const loopBodies = (src) => {
      const out = [];
      let i = src.indexOf('for await (const msg of client.fetch(');
      while (i !== -1) {
        let j = src.indexOf('}, { uid: true }))', i) + '}, { uid: true }))'.length;
        while (src[j] === ' ') j += 1;
        if (src[j] !== '{') { out.push(src.slice(j, src.indexOf(';', j) + 1)); }
        else {
          let depth = 0; let k = j;
          do { if (src[k] === '{') depth += 1; else if (src[k] === '}') depth -= 1; k += 1; } while (depth > 0 && k < src.length);
          out.push(src.slice(j, k));
        }
        i = src.indexOf('for await (const msg of client.fetch(', j);
      }
      return out;
    };
    for (const rel of ['services/mailThreads.js', 'services/mailSync.js']) {
      const bodies = loopBodies(read(rel));
      assert.ok(bodies.length >= 1, rel);
      for (const b of bodies) assert.doesNotMatch(b, /messageText|download|ingestMessage/, `${rel}: ${b}`);
    }
  });

  test('the first check backfills nothing (a new cursor starts at uidNext)', () => {
    assert.match(read('services/mailSync.js'), /return \{ cursor: \{ uidValidity, uidNext: status\.uidNext \}, seen: 0, stored: 0, started: true \};/);
  });
  test('traffic + analytics never read a subject or text', () => {
    const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // comments may SAY "subject"
    for (const rel of ['services/mailAnalytics.js']) assert.doesNotMatch(code(read(rel)), /subject|bodyText/, rel);
    const act = read('controllers/activityController.js');
    const fn = act.slice(act.indexOf('const getMailTrafficEvents'), act.indexOf('// views (the Staff File'));
    assert.doesNotMatch(code(fn), /subject|bodyText/);
  });
  test('the Composer "Patient file" header is written on drafts only', () => {
    const src = read('services/mailSend.js');
    assert.match(src, /if \(draft && linkUhids && linkUhids\.length\) headers\['X-HMS-Patient-Links'\]/);
    assert.equal((src.match(/X-HMS-Patient-Links/g) || []).length, 1);
  });
  test('the checker can be switched off, and is armed from server.js', () => {
    assert.match(read('services/mailSync.js'), /MAIL_SYNC_DISABLED === '1'/);
    assert.match(read('server.js'), /require\('\.\/services\/mailSync'\)\.startScheduler\(\)/);
  });
  test('migration: guarded, reversible, drops only what it added', () => {
    const src = read('migrations/20260926000005-patient-email-threads.js');
    const mig = require('../migrations/20260926000005-patient-email-threads.js');
    assert.equal(typeof mig.up, 'function'); assert.equal(typeof mig.down, 'function');
    assert.match(src, /bulkDelete\(EVENTS, \{ event: \['linked_to_patient', 'patient_email_removed'\] \}\)/);
    assert.match(src, /if \(!\(await tableExists\(queryInterface, MESSAGES\)\)\)/);
    assert.match(src, /if \(!cols\.syncState\)/);
  });
});
