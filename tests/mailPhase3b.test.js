const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Staff Email (B26) phase 3b — the parts that need no mailbox: preview-snippet
// decoding, the live INBOX watcher's start / back-off / stop rules (with a
// stubbed connection), the organise guard-rails, and the Activity Log's
// mail event types and filter groups. The IMAP behaviour itself is proven by
// the Dovecot end-to-end run (see the session doc).

const { snippetFrom, snippetPart, decodeTransfer, walkParts, shapeFolders } = require('../utils/mailRender');
const session = require('../services/mailSession');
const watch = require('../services/mailWatch');
const organise = require('../services/mailOrganise');
const { MAIL_EVENT_TYPES, ACTION_GROUPS } = require('../controllers/activityController');

// ---------------------------------------------------------------------------
describe('preview snippets', () => {
  test('plain text: whitespace collapsed, quoted reply lines dropped', () => {
    const s = snippetFrom(Buffer.from('Hi Emu,\r\n\r\nResults attached.\r\n> On Mon you wrote:\r\n> old text'), { charset: 'utf-8' });
    assert.equal(s, 'Hi Emu, Results attached.');
  });

  test('base64 cut mid-quantum still decodes what it can', () => {
    const b64 = Buffer.from('Lipid profile and HbA1c for CDC-0412 are ready.').toString('base64');
    const cut = b64.slice(0, 30) + '\r\n';   // not a multiple of 4
    const s = snippetFrom(Buffer.from(cut), { encoding: 'base64', charset: 'utf-8' });
    assert.ok('Lipid profile and HbA1c for CDC-0412 are ready.'.startsWith(s), s);
    assert.ok(s.length >= 20);
  });

  test('quoted-printable: soft breaks joined, =XX decoded, a half escape at the end ignored', () => {
    const qp = 'Caf=C3=A9 r=\r\nota for October =E2=80=94 see me=';
    assert.equal(snippetFrom(Buffer.from(qp), { encoding: 'quoted-printable', charset: 'utf-8' }), 'Café rota for October — see me');
  });

  test('latin-1 charset', () => {
    const buf = decodeTransfer(Buffer.from('Gr=FC=DFe', 'binary'), 'quoted-printable');
    assert.equal(snippetFrom(buf, { charset: 'iso-8859-1' }), 'Grüße');
  });

  test('HTML: style/script/head dropped, tags stripped, entities decoded, trailing half-tag cut', () => {
    const html = '<html><head><title>x</title><style>p{color:red}</style></head><body><p>Dear&nbsp;Dr &amp; team,</p><p>Pre-auth &#39;JH-88213&#39; approved</p><div class="sig';
    assert.equal(snippetFrom(Buffer.from(html), { isHtml: true }), "Dear Dr & team, Pre-auth 'JH-88213' approved");
  });

  test('clipped with an ellipsis; never longer than 140 characters', () => {
    const s = snippetFrom(Buffer.from('word '.repeat(100)), {});
    assert.ok(s.length <= 140);
    assert.ok(s.endsWith('…'));
  });

  test('unknown charset falls back to UTF-8 instead of throwing', () => {
    assert.equal(snippetFrom(Buffer.from('hello'), { charset: 'x-made-up' }), 'hello');
  });

  test('snippetPart prefers text/plain, uses HTML only when there is no text, and carries the encoding', () => {
    const alt = {
      type: 'multipart/alternative', childNodes: [
        { type: 'text/plain', part: '1', encoding: 'QUOTED-PRINTABLE', parameters: { charset: 'utf-8' } },
        { type: 'text/html', part: '2', encoding: 'base64', parameters: { charset: 'utf-8' } },
      ],
    };
    assert.deepEqual(snippetPart(alt), { part: '1', encoding: 'quoted-printable', charset: 'utf-8', isHtml: false });
    const htmlOnly = { type: 'text/html', encoding: 'base64', parameters: { charset: 'utf-8' } };
    assert.deepEqual(snippetPart(htmlOnly), { part: '1', encoding: 'base64', charset: 'utf-8', isHtml: true });
    assert.equal(snippetPart({ type: 'application/pdf', disposition: 'attachment', part: '1' }), null);
    assert.equal(walkParts(htmlOnly).html.encoding, 'base64');
  });
});

// ---------------------------------------------------------------------------
describe('live INBOX watcher (stubbed connection)', () => {
  const fakeClient = ({ unseen = [], newest = null } = {}) => {
    const handlers = {};
    const c = {
      usable: true,
      opened: null,
      loggedOut: false,
      mailbox: { uidValidity: 42n },
      on: (ev, fn) => { handlers[ev] = fn; },
      emit: (ev) => handlers[ev] && handlers[ev](),
      mailboxOpen: async (p, opts) => { c.opened = { p, opts }; },
      search: async () => unseen,
      fetchOne: async () => newest,
      logout: async () => { c.loggedOut = true; c.usable = false; },
      _set: (u, n) => { unseen = u; newest = n; },
    };
    return c;
  };

  const withStub = async (impl, fn) => {
    const real = session.openForUser;
    session.openForUser = impl;
    try { await fn(); } finally { session.openForUser = real; }
  };

  test('first ask starts ONE read-only INBOX watcher; later asks are answered from memory', async () => {
    let opens = 0;
    const c = fakeClient({ unseen: [5, 9], newest: { uid: 9, envelope: { subject: 'Results', from: [{ name: 'Lancet', address: 'r@lancet.co.ke' }] } } });
    await withStub(async () => { opens += 1; return c; }, async () => {
      const [a, b] = await Promise.all([watch.touch(901), watch.touch(901)]);
      assert.equal(opens, 1, 'two simultaneous asks must share one start');
      assert.deepEqual(c.opened, { p: 'INBOX', opts: { readOnly: true } });
      assert.equal(a.unread, 2);
      assert.equal(a.latest.uid, 9);
      assert.equal(a.latest.subject, 'Results');
      assert.equal(a.latest.from.address, 'r@lancet.co.ke');
      assert.deepEqual(a, b);
      c.search = async () => { throw new Error('must not hit the server on a plain ask'); };
      const again = await watch.touch(901);
      assert.equal(again.unread, 2);
      assert.equal(opens, 1);
      watch.stop(901);
      assert.equal(c.loggedOut, true);
      assert.equal(watch._watchers.has(901), false);
    });
  });

  test('a change reported over IDLE triggers a recount', async () => {
    const c = fakeClient({ unseen: [], newest: null });
    await withStub(async () => c, async () => {
      const first = await watch.touch(902);
      assert.equal(first.unread, 0);
      assert.equal(first.latest, null);
      c._set([3], { uid: 3, envelope: { subject: 'New', from: [{ address: 'a@b.c' }] } });
      c.emit('exists');
      await new Promise((r) => setTimeout(r, 600));
      const after = await watch.touch(902);
      assert.equal(after.unread, 1);
      assert.equal(after.latest.uid, 3);
      watch.stop(902);
    });
  });

  test('a failed start is not retried on every 30 s ask (one-minute back-off)', async () => {
    let opens = 0;
    const boom = Object.assign(new Error('refused'), { code: 'UNREACHABLE' });
    await withStub(async () => { opens += 1; throw boom; }, async () => {
      await assert.rejects(() => watch.touch(903), /refused/);
      await assert.rejects(() => watch.touch(903), /refused/);
      assert.equal(opens, 1);
      watch.stop(903);   // stop clears the back-off (e.g. after reconnecting)
      await assert.rejects(() => watch.touch(903), /refused/);
      assert.equal(opens, 2);
      watch.stop(903);
    });
  });

  test('closeClient (disconnect / wipe / password change) also stops the watcher', async () => {
    const c = fakeClient();
    await withStub(async () => c, async () => {
      await watch.touch(904);
      assert.equal(watch._watchers.has(904), true);
      session.closeClient(904);
      assert.equal(watch._watchers.has(904), false);
      assert.equal(c.loggedOut, true);
    });
  });

  test('the watcher never gives up the INBOX read-only guarantee or logs mail content', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mailWatch.js'), 'utf8');
    assert.match(src, /mailboxOpen\('INBOX', \{ readOnly: true \}\)/);
    assert.doesNotMatch(src, /messageFlags(Add|Remove|Set)|messageMove|messageDelete/);
    for (const m of src.matchAll(/console\.(error|log|warn)\(([^)]*)\)/g)) {
      assert.doesNotMatch(m[2], /subject|envelope|from|latest/i, `logs mail content: ${m[0]}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('organise guard-rails', () => {
  test('Empty Trash refuses without the literal word EMPTY and a count — before touching the mailbox', async () => {
    for (const confirm of [undefined, '', 'empty', 'EMPTY ', 'yes']) {
      await assert.rejects(() => organise.emptyTrash(905, { confirm, count: 3 }), (e) => e.code === 'CONFIRM');
    }
    await assert.rejects(() => organise.emptyTrash(905, { confirm: 'EMPTY' }), (e) => e.code === 'CONFIRM');
    await assert.rejects(() => organise.emptyTrash(905, { confirm: 'EMPTY', count: -1 }), (e) => e.code === 'CONFIRM');
  });

  test('nothing but emptyTrash can delete permanently', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mailOrganise.js'), 'utf8');
    const deletes = [...src.matchAll(/messageDelete\(/g)];
    assert.equal(deletes.length, 1);
    const at = src.indexOf('messageDelete(');
    const fnStart = src.lastIndexOf('const emptyTrash', at);
    const prevFn = src.lastIndexOf('\nconst ', at);
    assert.equal(fnStart, prevFn + 1, 'messageDelete must live inside emptyTrash');
    assert.doesNotMatch(src, /\\\\Deleted/);
    const send = fs.readFileSync(path.join(__dirname, '..', 'services', 'mailSend.js'), 'utf8');
    assert.doesNotMatch(send, /\\\\Deleted/, 'Discard draft must move to Trash, never flag \\Deleted');
  });

  test('cleanUidList: positive whole numbers, de-duplicated, at most 500, never empty', () => {
    assert.deepEqual(session.cleanUidList([3, '3', 7, -1, 'x', 0]), [3, 7]);
    assert.equal(session.cleanUidList(Array.from({ length: 900 }, (_, i) => i + 1)).length, 500);
    assert.throws(() => session.cleanUidList([]), (e) => e.code === 'BAD_UID');
    assert.throws(() => session.cleanUidList('1,2'), (e) => e.code === 'BAD_UID');
  });
});

// ---------------------------------------------------------------------------
describe('folder rail recognises unflagged standard folders by name', () => {
  test('an Archive the HMS created (no special-use flag) sits with the standard folders', () => {
    const r = shapeFolders([{ path: 'INBOX' }, { path: 'Archive' }, { path: 'Lancet' }]);
    assert.equal(r.find((f) => f.path === 'Archive').special, 'archive');
    assert.equal(r.find((f) => f.path === 'Lancet').special, null);
  });

  test('a flagged folder wins; a same-named look-alike stays an ordinary folder (never two Trashes)', () => {
    const r = shapeFolders([{ path: 'INBOX' }, { path: 'Bin', specialUse: '\\Trash' }, { path: 'Trash' }, { path: 'Deleted Items' }]);
    assert.deepEqual(r.filter((f) => f.special === 'trash').map((f) => f.path), ['Bin']);
  });

  test('namespace prefixes are ignored when guessing ("INBOX.Spam" is Junk)', () => {
    const r = shapeFolders([{ path: 'INBOX' }, { path: 'INBOX.Spam' }]);
    assert.equal(r.find((f) => f.path === 'INBOX.Spam').special, 'junk');
  });
});

// ---------------------------------------------------------------------------
describe('Activity Log — mail events', () => {
  test('every StaffMailEvent ENUM value has a type and a label', () => {
    const model = fs.readFileSync(path.join(__dirname, '..', 'models', 'StaffMailEvent.js'), 'utf8');
    const values = model.match(/ENUM\(([^)]*)\)/)[1].split(',').map((v) => v.trim().replace(/'/g, ''));
    assert.deepEqual(Object.keys(MAIL_EVENT_TYPES).sort(), values.sort());
    for (const t of Object.values(MAIL_EVENT_TYPES)) assert.ok(t.type && t.label);
  });

  test('the patient filter = emailed from a file + saved to a file (+ phase 4: emailed the patient); "all email" = every mail type', () => {
    assert.deepEqual(ACTION_GROUPS.mail_patient_docs.sort(), ['mail_linked_to_patient', 'mail_patient_emailed', 'mail_saved_to_patient', 'patient_docs_emailed']);
    // Phase 5: "all email" also holds every message sent/received (StaffMailTraffic).
    const { MAIL_TRAFFIC_TYPES } = require('../controllers/activityController');
    assert.deepEqual(ACTION_GROUPS.mail_all.sort(), [...Object.values(MAIL_EVENT_TYPES), ...Object.values(MAIL_TRAFFIC_TYPES)].map((t) => t.type).sort());
  });
});
