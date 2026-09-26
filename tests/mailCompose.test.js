const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRecipients, recipientSummary, prefixSubject, replyRecipients,
  threadHeaders, parseIdList, quoteOriginal, htmlToText, outgoingHtml, splitDraftHtml, joinBody, signatureBlock,
} = require('../utils/mailCompose');
const { _internals } = require('../services/mailSend');

// =====================================================================
// Staff Email (B26) phase 2 — composing: recipients, reply/forward shape,
// threading, the quoted original, and the raw message the HMS sends.
// =====================================================================

describe('parseRecipients', () => {
  test('strings, objects and pasted lists all parse; duplicates dropped; case folded', () => {
    const r = parseRecipients(['"Otieno, A" <AOtieno@Nairobihosp.org>; farah@cdiabetescentre.com', { name: 'Farah', address: 'FARAH@cdiabetescentre.com' }]);
    assert.deepEqual(r.ok.map((a) => a.address), ['aotieno@nairobihosp.org', 'farah@cdiabetescentre.com']);
    assert.equal(r.ok[0].name, 'Otieno, A');
    assert.deepEqual(r.bad, []);
  });

  test('a malformed address is reported, not silently dropped', () => {
    const r = parseRecipients(['someone@', 'ok@x.com']);
    assert.deepEqual(r.ok.map((a) => a.address), ['ok@x.com']);
    assert.equal(r.bad.length, 1);
  });

  test('header injection in a display name is flattened', () => {
    const r = parseRecipients([{ name: 'Evil\r\nBcc: x@y.com', address: 'a@b.com' }]);
    assert.ok(!/[\r\n]/.test(r.ok[0].name));
  });
});

describe('recipientSummary (the metadata-only sent audit)', () => {
  test('counts and domains only — never addresses', () => {
    const s = recipientSummary([[{ address: 'a@x.com' }], [{ address: 'b@x.com' }, { address: 'c@y.org' }]]);
    assert.deepEqual(s, { count: 3, domains: ['x.com', 'y.org'] });
    assert.ok(!JSON.stringify(s).includes('@'));
  });
});

describe('subjects', () => {
  test('prefixes do not stack', () => {
    assert.equal(prefixSubject('Re: RE: Fwd: Referral', 'reply'), 'Re: Referral');
    assert.equal(prefixSubject('Re: Referral', 'forward'), 'Fwd: Referral');
    assert.equal(prefixSubject('', 'reply'), 'Re:');
  });
});

describe('replyRecipients', () => {
  const msg = {
    from: { name: 'Dr A', address: 'a@hosp.org' },
    to: [{ name: 'Emu', address: 'ebrahim@cdiabetescentre.com' }, { name: '', address: 'farah@cdiabetescentre.com' }],
    cc: [{ name: '', address: 'lab@hosp.org' }, { name: '', address: 'A@hosp.org' }],
    replyTo: [],
  };
  const own = 'Ebrahim@cdiabetescentre.com';

  test('reply → the sender only', () => {
    assert.deepEqual(replyRecipients(msg, 'reply', own), { to: [{ name: 'Dr A', address: 'a@hosp.org' }], cc: [] });
  });

  test('reply all → sender + To + Cc, minus me and duplicates', () => {
    const r = replyRecipients(msg, 'replyAll', own);
    assert.deepEqual(r.to.map((a) => a.address), ['a@hosp.org']);
    assert.deepEqual(r.cc.map((a) => a.address), ['farah@cdiabetescentre.com', 'lab@hosp.org']);
  });

  test('Reply-To wins over From', () => {
    const r = replyRecipients({ ...msg, replyTo: [{ name: '', address: 'desk@hosp.org' }] }, 'reply', own);
    assert.deepEqual(r.to.map((a) => a.address), ['desk@hosp.org']);
  });

  test('replying to my own sent message goes back to its recipients', () => {
    const mine = { from: { address: 'ebrahim@cdiabetescentre.com' }, to: [{ address: 'x@y.com' }], cc: [] };
    assert.deepEqual(replyRecipients(mine, 'reply', own).to.map((a) => a.address), ['x@y.com']);
  });

  test('forward → nobody', () => {
    assert.deepEqual(replyRecipients(msg, 'forward', own), { to: [], cc: [] });
  });
});

describe('threading headers', () => {
  test('In-Reply-To = the original id; References = its chain + the original', () => {
    const t = threadHeaders({ messageId: '<m3@x>', references: '<m1@x> <m2@x>' });
    assert.equal(t.inReplyTo, '<m3@x>');
    assert.deepEqual(t.references, ['<m1@x>', '<m2@x>', '<m3@x>']);
  });

  test('no Message-ID → no In-Reply-To, chain kept', () => {
    assert.equal(threadHeaders({ messageId: null, references: '<m1@x>' }).inReplyTo, null);
  });

  test('References is capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' ');
    assert.equal(threadHeaders({ messageId: '<last@x>', references: many }).references.length, 20);
  });

  test('parseIdList ignores junk', () => {
    assert.deepEqual(parseIdList('junk <a@b> more <c@d>'), ['<a@b>', '<c@d>']);
  });
});

describe('quoted original', () => {
  const msg = {
    from: { name: 'Dr <A>', address: 'a@hosp.org' }, to: [{ address: 'e@cdc.com' }], cc: [],
    subject: 'Referral', date: '2026-09-24T07:12:00Z', html: '<p>Please review</p><script>x()</script>',
  };

  test('reply quote escapes the sender and keeps the body sanitised', () => {
    const q = quoteOriginal(msg, 'reply');
    assert.match(q, /Dr &lt;A&gt;/);
    assert.match(q, /<blockquote/);
    assert.ok(!/<script/i.test(q));
  });

  test('forward carries a header block', () => {
    const q = quoteOriginal(msg, 'forward');
    assert.match(q, /Forwarded message/);
    assert.match(q, /<b>Subject:<\/b> Referral/);
  });
});

describe('drafts: the editable part never carries the quote or a sender\'s styles', () => {
  test('a saved draft splits back into body + quote', () => {
    const saved = outgoingHtml(joinBody('<p>My reply</p>', '<div data-hms-quote="reply"><p>On … wrote:</p><blockquote><style>body{display:none}</style>old</blockquote></div>'));
    const { body, quote } = splitDraftHtml(saved);
    assert.equal(body, '<p>My reply</p>');
    assert.match(quote, /^<div data-hms-quote="reply"/);
  });

  test('document wrappers and <style> are stripped from the editable body', () => {
    const { body, quote } = splitDraftHtml('<!doctype html><html><head><meta charset="utf-8"><style>*{color:red}</style></head><body><p>Hi</p></body></html>');
    assert.equal(body, '<p>Hi</p>');
    assert.equal(quote, '');
  });

  test('the quote drops embedded data: images', () => {
    const q = quoteOriginal({ from: { address: 'a@b.com' }, html: '<p>x</p><img src="data:image/png;base64,AAAA">', date: null }, 'reply');
    assert.ok(!/data:image/.test(q));
  });

  test('joinBody sanitises the quote', () => {
    assert.ok(!/<script/i.test(joinBody('<p>a</p>', '<div data-hms-quote="reply"><script>x()</script></div>')));
  });
});

describe('signature: the person\'s lines above the clinic block', () => {
  const clinic = {
    clinicName: 'Comprehensive Diabetes Centre', address: '3rd Floor, Doctors Park', phone: '0711 781299',
    email: 'info@cdiabetescentre.com', website: 'comprehensivediabetescentre.com',
    confidentialityOn: true, confidentialityText: 'Confidential <patient> info.',
  };

  test('personal lines, clinic details, cid logo and the note all present', () => {
    const h = signatureBlock({ personalHtml: 'Dr Ebrahim Yusuf<br>Consultant Physician', clinic, logoSrc: 'cid:clinic-logo.1@hms' });
    assert.match(h, /Dr Ebrahim Yusuf<br>Consultant Physician/);
    assert.match(h, /Comprehensive Diabetes Centre/);
    assert.match(h, /mailto:info@cdiabetescentre\.com/);
    assert.match(h, /href="https:\/\/comprehensivediabetescentre\.com"/);
    assert.match(h, /src="cid:clinic-logo\.1@hms"/);
    assert.match(h, /Confidential &lt;patient&gt; info\./);
  });

  test('the note can be switched off; no logo means no image', () => {
    const h = signatureBlock({ personalHtml: '', clinic: { ...clinic, confidentialityOn: false }, logoSrc: null });
    assert.ok(!/Confidential/.test(h));
    assert.ok(!/<img/.test(h));
  });

  test('clinic fields are escaped and the personal part is sanitised', () => {
    const h = signatureBlock({ personalHtml: 'Me<script>x()</script><img src=x onerror=y()>', clinic: { clinicName: '<b>CDC</b>' }, logoSrc: null });
    assert.ok(!/<script|onerror/i.test(h));
    assert.match(h, /&lt;b&gt;CDC&lt;\/b&gt;/);
  });

  test('nothing to show → empty string', () => {
    assert.equal(signatureBlock({ personalHtml: '', clinic: {}, logoSrc: null }), '');
  });
});

describe('outgoing body', () => {
  test('plain-text alternative keeps lines, lists and links', () => {
    const t = htmlToText('<p>Dear Dr A,</p><ul><li>CGM</li><li>Review</li></ul><a href="https://x.org">here</a>&amp; done');
    assert.match(t, /Dear Dr A,/);
    assert.match(t, /- CGM\n- Review/);
    assert.match(t, /here \(https:\/\/x\.org\)/);
    assert.match(t, /& done/);
  });

  test('scripts and handlers never leave the HMS', () => {
    const h = outgoingHtml('<p onclick="x()">hi</p><script>bad()</script>');
    assert.ok(!/onclick|<script/i.test(h));
  });
});

describe('the raw message', () => {
  const base = {
    from: { name: 'Dr Ebrahim', address: 'ebrahim@cdiabetescentre.com' },
    rcpt: { to: [{ name: '', address: 'a@hosp.org' }], cc: [], bcc: [{ name: '', address: 'secret@x.com' }] },
    subject: 'Re: Referral', html: '<p>Hello</p>', inReplyTo: '<m3@x>', references: ['<m1@x>', '<m3@x>'],
    attachments: [{ filename: 'labs.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }],
    messageId: '<abc@cdiabetescentre.com>', date: new Date('2026-09-26T10:00:00Z'),
  };

  test('the SMTP copy never carries Bcc; the Sent copy does', async () => {
    const smtp = (await _internals.buildRaw({ ...base, keepBcc: false })).toString();
    const sent = (await _internals.buildRaw({ ...base, keepBcc: true })).toString();
    assert.ok(!/^Bcc:/im.test(smtp));
    assert.match(sent, /^Bcc: secret@x\.com/im);
  });

  test('threading headers, Message-ID and the attachment are present', async () => {
    const raw = (await _internals.buildRaw({ ...base, keepBcc: false })).toString();
    assert.match(raw, /^In-Reply-To: <m3@x>/im);
    assert.match(raw, /^References: <m1@x> <m3@x>/im);
    assert.match(raw, /^Message-ID: <abc@cdiabetescentre\.com>/im);
    assert.match(raw, /filename=labs\.pdf/);
    assert.match(raw, /multipart\/alternative/);
  });

  test('recipientsFrom refuses no recipients on send, allows none on a draft', () => {
    assert.throws(() => _internals.recipientsFrom({}, true), (e) => e.code === 'NO_RECIPIENT');
    assert.deepEqual(_internals.recipientsFrom({}, false), { to: [], cc: [], bcc: [] });
  });

  test('carried attachment refs are validated', () => {
    assert.deepEqual(_internals.cleanRefs([{ folder: 'INBOX', uid: '7', part: '2' }, { folder: 'INBOX', uid: 1, part: '../x' }, { uid: 3, part: '1' }]),
      [{ folder: 'INBOX', uid: 7, part: '2' }]);
  });
});
