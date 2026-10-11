// =====================================================================
// Consultation notes — history sections (10 Oct 2026, Emu).
//
// The Initial Assessment (a one-time, diabetes-only form) is gone. Instead a
// consultation note is made of SECTIONS the doctor adds as they write —
// Presenting complaint, History of presenting illness, Past medical history,
// Drug history, Allergies … — each saved as its own row
// (ConsultationNoteSections, with its ticks in ConsultationNoteSectionItems)
// so the clinic can report on them ("patients with retinopathy marked Yes").
//
// This file is the vocabulary and the pure rules. The frontend keeps the same
// keys in constants/noteSections.js (a test compares them).
//
//   SECTIONS        every section the note knows, in CLINICAL ORDER (the
//                   order they appear in the note whatever order they were
//                   added in)
//     key           stored in ConsultationNoteSections.key
//     group         visit  — this visit only, never carried forward
//                   bg     — background: carried forward from the last time
//                            it was written (or from the patient file)
//                   dm     — diabetes add-on (carried forward)
//                   derm   — dermatology add-on (module 'dermatology')
//     kind          text | chips | rows | meds — how the items are rendered
//                   as plain text; chips tick an item ("Polyuria" = yes),
//                   rows pick one value per item ("Retinopathy" = "No"),
//                   meds list medicines ("Metformin 1 g BD" = current|stopped)
//     carry         true when the last saved copy pre-fills the next note
//
//   sanitizeNoteHtml  the ONLY formatting a note keeps: bold, italic,
//                     underline, highlight, bullet and numbered lists, line
//                     breaks and paragraphs. Every attribute and every other
//                     tag is dropped (the text inside is kept), so nothing
//                     pasted from Word or a web page can carry styling or
//                     script into the record.
//   htmlToText        the plain-text copy of a section (search, the Admit /
//                     Refer prefill, the old readers of ConsultationNote.notes)
//   renderNoteText    the whole note as plain text — what ConsultationNote.notes
//                     holds once a note is made of sections
//   cleanSections     what the client sent → the rows to save
// =====================================================================

const SECTIONS = [
  { key: 'pc',       label: 'Presenting complaint',           group: 'visit', kind: 'chips', carry: false },
  { key: 'hpi',      label: 'History of presenting illness',  group: 'visit', kind: 'text',  carry: false },
  { key: 'ros',      label: 'Review of systems',              group: 'visit', kind: 'chips', carry: true },
  { key: 'pmh',      label: 'Past medical history',           group: 'bg',    kind: 'text',  carry: true },
  { key: 'psh',      label: 'Past surgical history',          group: 'bg',    kind: 'text',  carry: true },
  { key: 'dh',       label: 'Drug history',                   group: 'bg',    kind: 'meds',  carry: true },
  { key: 'al',       label: 'Allergies',                      group: 'bg',    kind: 'text',  carry: true },
  { key: 'fh',       label: 'Family history',                 group: 'bg',    kind: 'chips', carry: true },
  { key: 'sh',       label: 'Social history',                 group: 'bg',    kind: 'rows',  carry: true },
  { key: 'gyn',      label: 'Obstetric & gynae history',      group: 'bg',    kind: 'text',  carry: true },
  { key: 'dm_comp',  label: 'Diabetes complications screen',  group: 'dm',    kind: 'rows',  carry: true },
  { key: 'derm_skin', label: 'Skin history',                  group: 'derm',  kind: 'text',  carry: true, module: 'dermatology' },
  { key: 'imp',      label: 'Notes',                          group: 'visit', kind: 'text',  carry: false },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);
const CARRY_KEYS = SECTIONS.filter((s) => s.carry).map((s) => s.key);
const sectionByKey = (key) => SECTIONS.find((s) => s.key === key) || null;
const positionOf = (key) => SECTION_KEYS.indexOf(key);

// ---------------------------------------------------------------------
// HTML — the allow-list sanitiser
// ---------------------------------------------------------------------
const INLINE = { strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'u', mark: 'mark' };
const BLOCK = { p: 'p', div: 'div', ul: 'ul', ol: 'ol', li: 'li' };
const MAX_HTML = 50000;

const escapeText = (s) => String(s)
  // a bare & (not already an entity) is escaped; real entities pass through
  .replace(/&(?!(?:[a-zA-Z]{2,10}|#\d{1,6}|#x[0-9a-fA-F]{1,5});)/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * Keep only the tags a note may carry, drop every attribute, balance the
 * result. Text inside a dropped tag is kept; <script>/<style> contents are not.
 */
const sanitizeNoteHtml = (html) => {
  let src = String(html == null ? '' : html);
  if (src.length > MAX_HTML) src = src.slice(0, MAX_HTML);
  src = src.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const open = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok[0] !== '<') { out.push(escapeText(tok)); continue; }
    if (tok === '<') { out.push('&lt;'); continue; }
    const name = m[1].toLowerCase();
    const closing = tok[1] === '/';
    if (name === 'br') { if (!closing) out.push('<br>'); continue; }
    const mapped = INLINE[name] || BLOCK[name];
    if (!mapped) continue;                       // unknown tag: dropped, text kept
    if (!closing) {
      // a <li> or <p> opened while one is still open closes it first (as a
      // browser does — contentEditable emits unclosed ones)
      if ((mapped === 'li' || mapped === 'p') && open[open.length - 1] === mapped) { open.pop(); out.push(`</${mapped}>`); }
      out.push(`<${mapped}>`);
      open.push(mapped);
    } else {
      const at = open.lastIndexOf(mapped);
      if (at < 0) continue;                      // stray close: dropped
      while (open.length > at) out.push(`</${open.pop()}>`);
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('')
    .replace(/<(strong|em|u|mark|p|div|li)><\/\1>/g, '')  // empty marks and blocks
    .replace(/(<(div|p)>(<br>|\s)*<\/\2>|<br>|\s)+$/g, '')   // no empty lines hang off the end
    .replace(/^(<br>|\s)+/g, '');
};

// ---------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, ent) => {
  if (ent[0] === '#') {
    const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : all;
});

/** The text a section's HTML reads as: bullets become "• ", numbers "1. ". */
const htmlToText = (html) => {
  const lists = [];   // stack of { kind, n }
  let out = '';
  const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };   // start a new line, never a blank one
  const src = String(html == null ? '' : html).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok[0] !== '<' || tok === '<') { out += tok; continue; }
    const name = m[1].toLowerCase();
    const closing = tok[1] === '/';
    if (name === 'br') { out += '\n'; continue; }
    if (name === 'ul' || name === 'ol') {
      if (closing) { lists.pop(); nl(); } else { lists.push({ kind: name, n: 0 }); nl(); }
      continue;
    }
    if (name === 'li') {
      if (closing) { nl(); continue; }
      nl();
      const top = lists[lists.length - 1];
      if (!top) { out += '• '; continue; }
      top.n += 1;
      out += `${'  '.repeat(Math.max(0, lists.length - 1))}${top.kind === 'ol' ? `${top.n}. ` : '• '}`;
      continue;
    }
    // Enter in a contentEditable makes <div>next line</div>; a blank line is
    // <div><br></div>. A paragraph keeps a blank line after it.
    if (name === 'div') { if (!closing) nl(); continue; }
    if (name === 'p') { nl(); if (closing) out += '\n'; continue; }
  }
  const text = decodeEntities(out)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  return text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
};

// ---------------------------------------------------------------------
// Items (ticks) → text, and the whole note → text
// ---------------------------------------------------------------------
const itemsText = (kind, items) => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  if (kind === 'chips') return list.filter((i) => i.value !== 'no').map((i) => i.item).join(', ');
  if (kind === 'meds') {
    const current = list.filter((i) => i.value === 'current').map((i) => `• ${i.item}`);
    const stopped = list.filter((i) => i.value === 'stopped').map((i) => `• ${i.item} (stopped)`);
    return [...current, ...stopped].join('\n');
  }
  return list.map((i) => `${i.item}: ${i.value}`).join(' · ');
};

/** One section as plain text: its ticks, then its text (no heading). */
const sectionText = (section) => {
  const def = sectionByKey(section.key) || { kind: 'text' };
  const parts = [itemsText(def.kind, section.items), htmlToText(section.html)].filter((p) => p && p.trim());
  return parts.join('\n');
};

/**
 * The whole note as plain text — "HEADING\ntext" per section, blank line
 * between. This is what ConsultationNote.notes holds for a note made of
 * sections, so search, the staff view and the Admit / Refer prefill keep
 * working unchanged.
 */
const renderNoteText = (sections) => (Array.isArray(sections) ? sections : [])
  .map((s) => {
    const def = sectionByKey(s.key);
    const body = sectionText(s);
    if (!def || !body) return '';
    const mark = s.reviewed ? ' (reviewed — no change)' : '';
    return `${def.label.toUpperCase()}${mark}\n${body}`;
  })
  .filter(Boolean)
  .join('\n\n');

// ---------------------------------------------------------------------
// What the client sends → the rows to save
// ---------------------------------------------------------------------
const MAX_ITEMS = 200;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * @returns {Array<{key, position, html, text, items:[{item,value}], reviewed, carriedFromSectionId}>}
 *   in clinical order, one per key, empty sections dropped. Unknown keys and
 *   anything that is not an array are ignored (a legacy client sends none).
 */
const cleanSections = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const rows = [];
  raw.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    const key = str(s.key, 40);
    const def = sectionByKey(key);
    if (!def || seen.has(key)) return;
    seen.add(key);
    const html = sanitizeNoteHtml(s.html);
    const items = (Array.isArray(s.items) ? s.items : [])
      .map((i) => (i && typeof i === 'object' ? { item: str(i.item, 120), value: str(i.value, 120) || 'yes' } : null))
      .filter((i) => i && i.item)
      .slice(0, MAX_ITEMS);
    // the same tick twice is one tick
    const uniq = [];
    const seenItems = new Set();
    items.forEach((i) => { const k = `${i.item}\u0000${i.value}`; if (!seenItems.has(k)) { seenItems.add(k); uniq.push(i); } });
    const text = sectionText({ key, html, items: uniq });
    if (!text) return;                           // nothing in it: not saved
    const carried = Number.parseInt(s.carriedFromSectionId, 10);
    rows.push({
      key,
      position: positionOf(key),
      html,
      text,
      items: uniq,
      reviewed: s.reviewed === true,
      carriedFromSectionId: Number.isInteger(carried) && carried > 0 ? carried : null,
    });
  });
  rows.sort((a, b) => a.position - b.position);
  return rows;
};

module.exports = {
  SECTIONS, SECTION_KEYS, CARRY_KEYS, sectionByKey, positionOf,
  sanitizeNoteHtml, htmlToText, decodeEntities, itemsText, sectionText, renderNoteText, cleanSections,
  MAX_HTML,
};
