const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  walkParts, hasAttachments, textToHtml, sanitizeHtml, hasRemoteContent,
  inlineCids, addressList, isExternal, shapeFolders,
} = require('../utils/mailRender');
const { serversFor } = require('../utils/mailProviders');

// =====================================================================
// Staff Email (B26) — the pure pieces: picking the body out of a MIME tree,
// making it safe to show, and the shape of the routes (decision D1: no route
// can select another person's mailbox).
// =====================================================================

const ALT = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/related', part: '1',
      childNodes: [
        {
          type: 'multipart/alternative', part: '1.1',
          childNodes: [
            { type: 'text/plain', part: '1.1.1', parameters: { charset: 'utf-8' }, size: 120 },
            { type: 'text/html', part: '1.1.2', parameters: { charset: 'utf-8' }, size: 900 },
          ],
        },
        { type: 'image/png', part: '1.2', id: '<logo@cdc>', disposition: 'inline', size: 4000 },
      ],
    },
    { type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'results.pdf' }, size: 200000 },
  ],
};

describe('walkParts picks the body and the attachments', () => {
  test('html + text alternative, inline cid image, pdf attachment', () => {
    const p = walkParts(ALT);
    assert.equal(p.html.part, '1.1.2');
    assert.equal(p.text.part, '1.1.1');
    assert.deepEqual(p.inline.map((i) => [i.part, i.contentId]), [['1.2', 'logo@cdc']]);
    assert.deepEqual(p.attachments.map((a) => [a.part, a.filename]), [['2', 'results.pdf']]);
    assert.equal(hasAttachments(ALT), true);
  });

  test('a single-part plain message is part 1 with no attachments', () => {
    const p = walkParts({ type: 'text/plain', parameters: { charset: 'iso-8859-1' }, size: 10 });
    assert.equal(p.text.part, '1');
    assert.equal(p.html, null);
    assert.equal(p.attachments.length, 0);
    assert.equal(hasAttachments({ type: 'text/plain' }), false);
  });

  test('a text file sent as an attachment is an attachment, not the body', () => {
    const p = walkParts({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1', size: 5 },
        { type: 'text/plain', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } },
      ],
    });
    assert.equal(p.text.part, '1');
    assert.deepEqual(p.attachments.map((a) => a.filename), ['notes.txt']);
  });

  test('an image marked attachment stays an attachment even with a Content-ID', () => {
    const p = walkParts({ type: 'multipart/mixed', childNodes: [
      { type: 'text/html', part: '1' },
      { type: 'image/jpeg', part: '2', id: '<x@y>', disposition: 'attachment', dispositionParameters: { filename: 'scan.jpg' } },
    ] });
    assert.equal(p.inline.length, 0);
    assert.equal(p.attachments[0].filename, 'scan.jpg');
  });
});

describe('rendering is safe', () => {
  test('scripts, handlers, frames, forms and javascript: links are stripped', () => {
    const dirty = '<p onclick="steal()">Hi</p><script>alert(1)</script><iframe src="x"></iframe>'
      + '<a href="javascript:alert(1)">x</a><form action="https://evil"><input></form>'
      + '<meta http-equiv="refresh" content="0;url=https://evil"><img src=x onerror=alert(1)>';
    const clean = sanitizeHtml(dirty);
    assert.doesNotMatch(clean, /<script|onclick|onerror|<iframe|javascript:|<form|http-equiv/i);
    assert.match(clean, /<p>Hi<\/p>/);
  });

  test('plain text is escaped and links become anchors', () => {
    const html = textToHtml('a <b> & https://example.com/x?y=1');
    assert.match(html, /a &lt;b&gt; &amp; /);
    assert.match(html, /<a href="https:\/\/example.com\/x\?y=1">/);
  });

  test('remote content is detected (images, css url, protocol-relative)', () => {
    assert.equal(hasRemoteContent('<img src="https://t.co/p.gif">'), true);
    assert.equal(hasRemoteContent('<img src=//t.co/p.gif>'), true);
    assert.equal(hasRemoteContent('<div style="background:url(\'http://x/y.png\')">'), true);
    assert.equal(hasRemoteContent('<img src="data:image/png;base64,AAA">'), false);
    assert.equal(hasRemoteContent('<a href="https://x">link only</a>'), false);
  });

  test('cid references become data URIs', () => {
    const out = inlineCids('<img src="cid:logo@cdc">', { 'logo@cdc': 'data:image/png;base64,AAA' });
    assert.equal(out, '<img src="data:image/png;base64,AAA">');
  });
});

describe('addresses and folders', () => {
  test('address lists are normalised and blanks dropped', () => {
    assert.deepEqual(addressList([{ name: 'Lab', address: 'Results@Lab.co.ke' }, {}, null]),
      [{ name: 'Lab', address: 'results@lab.co.ke' }]);
  });

  test('External means outside every allowed clinic domain', () => {
    assert.equal(isExternal('a@cdiabetescentre.com', ['cdiabetescentre.com']), false);
    assert.equal(isExternal('results@lancet.co.ke', ['cdiabetescentre.com']), true);
    assert.equal(isExternal('', ['cdiabetescentre.com']), true);
  });

  test('folders: special-use names, order, Noselect dropped', () => {
    const rows = [
      { path: 'Referrals', name: 'Referrals', flags: new Set() },
      { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set(), status: { messages: 3, unseen: 0 } },
      { path: 'INBOX', name: 'INBOX', flags: new Set(), status: { messages: 10, unseen: 2 } },
      { path: 'INBOX.Sent', name: 'Sent Items', specialUse: '\\Sent', flags: new Set() },
      { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']) },
    ];
    const f = shapeFolders(rows);
    assert.deepEqual(f.map((x) => x.name), ['Inbox', 'Sent', 'Trash', 'Referrals']);
    assert.equal(f[0].unseen, 2);
  });
});

describe('provider presets', () => {
  test('one.com resolves to imap.one.com:993 and send.one.com:465', () => {
    const s = serversFor({ domain: 'cdiabetescentre.com', provider: 'onecom' });
    assert.deepEqual(s.imap, { host: 'imap.one.com', port: 993, secure: true });
    assert.deepEqual(s.smtp, { host: 'send.one.com', port: 465, secure: true });
  });

  test('custom needs both servers, otherwise null', () => {
    assert.equal(serversFor({ domain: 'x.com', provider: 'custom', imapHost: 'imap.x.com', imapPort: 993 }), null);
    const s = serversFor({ domain: 'x.com', provider: 'custom', imapHost: 'imap.x.com', imapPort: 993, smtpHost: 'smtp.x.com', smtpPort: 587, smtpSecure: false });
    assert.equal(s.smtp.secure, false);
  });
});

describe('decision D1: no route can select another person\'s mailbox', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mail.js'), 'utf8');
  const routes = [...text.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'([^\n]*)/g)]
    .map((m) => ({ method: m[1], path: m[2], gate: m[3] }));

  test('only /admin routes carry a :userId, and they are admin/config.write gated', () => {
    for (const r of routes) {
      if (/:userId/.test(r.path)) {
        assert.match(r.path, /^\/admin\//, `${r.path} takes a user id outside /admin`);
        assert.match(r.gate, /authorize\('admin', 'config\.write'\)/);
      }
    }
  });

  test('no admin route reads mail — status and disconnect only', () => {
    const admin = routes.filter((r) => r.path.startsWith('/admin/'));
    assert.deepEqual(admin.map((r) => `${r.method} ${r.path}`).sort(),
      ['get /admin/accounts', 'post /admin/accounts/:userId/disconnect']);
  });

  test('every non-admin route is gated on the MAIL list', () => {
    for (const r of routes.filter((x) => !x.path.startsWith('/admin/'))) {
      assert.match(r.gate, /authorize\(\.\.\.MAIL\)/, `${r.method} ${r.path}`);
    }
  });
});
