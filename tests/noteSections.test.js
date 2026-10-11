// Consultation notes — history sections (10 Oct 2026). Pure rules only; the
// DB side is exercised in the scratch-DB run (see the session doc).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SECTIONS, SECTION_KEYS, CARRY_KEYS, sanitizeNoteHtml, htmlToText, renderNoteText, cleanSections, positionOf,
} = require('../utils/noteSections');
const { TOOL_IDS, cleanToolPrefs } = require('../utils/consultationTools');

const FE = path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src');
const hasFrontend = fs.existsSync(FE);
const feRead = (rel) => fs.readFileSync(path.join(FE, rel), 'utf8');

describe('the vocabulary', () => {
  test('keys are unique, in clinical order, and the frontend knows the same ones', () => {
    assert.equal(new Set(SECTION_KEYS).size, SECTION_KEYS.length);
    assert.deepEqual(SECTION_KEYS.slice(0, 3), ['pc', 'hpi', 'ros']);
    assert.equal(SECTION_KEYS[SECTION_KEYS.length - 1], 'imp');
    if (!hasFrontend) return;
    const fe = [...feRead('constants/noteSections.js').matchAll(/\{ key: '([a-z_]+)',\s+label:/g)].map((m) => m[1]);
    assert.deepEqual(fe, SECTION_KEYS);
  });
  test('presenting complaint, HPI and the impression never carry forward; everything else does (Emu, 10 Oct)', () => {
    assert.deepEqual(SECTION_KEYS.filter((k) => !CARRY_KEYS.includes(k)), ['pc', 'hpi', 'imp']);
    assert.ok(SECTIONS.find((s) => s.key === 'derm_skin').module === 'dermatology');
  });
  test('the Initial assessment module is retired from Today\'s Consultation', () => {
    assert.ok(!TOOL_IDS.includes('assessment'));
    assert.deepEqual(cleanToolPrefs({ order: ['assessment', 'notes'], hidden: ['assessment'], open: [] }), { order: ['notes'], hidden: [], open: [] });
  });
});

describe('sanitizeNoteHtml — only bold / italic / underline / highlight / lists survive', () => {
  test('attributes, scripts, links, images and unknown tags are dropped; their text is kept', () => {
    const dirty = '<div onclick="x()">Hello <b style="color:red">bold</b> &amp; <script>alert(1)</script>'
      + '<span class="a">sp</span><ul><li>one<li>two</ul><img src=x><a href="javascript:1">link</a> a < b</div><p>';
    assert.equal(sanitizeNoteHtml(dirty), '<div>Hello <strong>bold</strong> &amp; sp<ul><li>one</li><li>two</li></ul>link a &lt; b</div>');
  });
  test('b/i become strong/em; mark and u are kept; stray closes are dropped; tags are balanced', () => {
    assert.equal(sanitizeNoteHtml('<i>a</i></strong><mark>hi</mark><u>u'), '<em>a</em><mark>hi</mark><u>u</u>');
    assert.equal(sanitizeNoteHtml('<ol><li><strong>x</li></ol>'), '<ol><li><strong>x</strong></li></ol>');
  });
  test('nothing active can pass — the usual tricks', () => {
    for (const s of ['<svg onload=alert(1)>', '<img src=x onerror=alert(1)>', '<iframe src="x">', '<style>*{display:none}</style>x', '<a href="data:text/html,x">y</a>', '<div onmouseover="x">z</div>']) {
      const out = sanitizeNoteHtml(s);
      assert.ok(!/on[a-z]+=|<svg|<img|<iframe|<style|href=|<a\b/i.test(out), `${s} → ${out}`);
    }
  });
  test('an empty note is empty; a very long note is cut', () => {
    assert.equal(sanitizeNoteHtml('<br><br>  <div></div>'), '');
    assert.ok(sanitizeNoteHtml('a'.repeat(60000)).length <= 50000);
  });
});

describe('htmlToText — the plain copy', () => {
  test('lines, bullets, numbers and entities', () => {
    const html = 'Hello <strong>bold</strong> &amp; sp<ul><li>one</li><li>two</li></ul><ol><li>x<br>y</li></ol>para&nbsp;end<div>line2</div><div><br></div><div>line4</div>';
    assert.equal(htmlToText(html), 'Hello bold & sp\n• one\n• two\n1. x\ny\npara end\nline2\n\nline4');
    assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\n\nb');
    assert.equal(htmlToText('&#39;q&#x27; &lt;3'), "'q' <3");
  });
});

describe('cleanSections + renderNoteText', () => {
  test('unknown keys and empty sections are dropped; keys are deduped; clinical order wins over click order', () => {
    const rows = cleanSections([
      { key: 'imp', html: '<p>Impression</p>' },
      { key: 'zz', html: 'nope' },
      { key: 'hpi', html: '<br> ' },
      { key: 'pc', items: [{ item: 'Polyuria' }, { item: 'Polyuria' }, { item: 'Fatigue', value: 'yes' }], html: '' },
      { key: 'pc', html: 'dup' },
      { key: 'dm_comp', items: [{ item: 'Retinopathy', value: 'No' }, { item: 'Nephropathy', value: 'Not known' }], reviewed: true, carriedFromSectionId: '12' },
    ]);
    assert.deepEqual(rows.map((r) => r.key), ['pc', 'dm_comp', 'imp']);
    assert.deepEqual(rows[0].items, [{ item: 'Polyuria', value: 'yes' }, { item: 'Fatigue', value: 'yes' }]);
    assert.equal(rows[0].text, 'Polyuria, Fatigue');
    assert.equal(rows[1].reviewed, true);
    assert.equal(rows[1].carriedFromSectionId, 12);
    assert.equal(rows[1].text, 'Retinopathy: No · Nephropathy: Not known');
    assert.ok(rows[0].position < rows[1].position && rows[1].position < rows[2].position);
    assert.equal(positionOf('imp'), SECTION_KEYS.length - 1);
    assert.equal(renderNoteText(rows), 'PRESENTING COMPLAINT\nPolyuria, Fatigue\n\nDIABETES COMPLICATIONS SCREEN (reviewed — no change)\nRetinopathy: No · Nephropathy: Not known\n\nNOTES\nImpression');
  });
  test('drug history: current medicines then stopped ones', () => {
    const rows = cleanSections([{ key: 'dh', items: [{ item: 'Metformin 1 g BD', value: 'current' }, { item: 'Gliclazide 80 mg BD', value: 'stopped' }], html: 'Herbal tea' }]);
    assert.equal(rows[0].text, '• Metformin 1 g BD\n• Gliclazide 80 mg BD (stopped)\nHerbal tea');
  });
  test('not an array → no sections (a legacy client)', () => {
    assert.deepEqual(cleanSections(undefined), []);
    assert.deepEqual(cleanSections('x'), []);
  });
});
