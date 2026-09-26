// ---------------------------------------------------------------------------
// Staff Email (B26) — pure helpers for turning an IMAP message into something
// safe to show. No I/O here, so every function is unit-tested directly
// (tests/mailRender.test.js).
//
// SAFETY MODEL. The real guard is the browser: the frontend renders the HTML
// in an <iframe sandbox> with NO allow-scripts and NO allow-same-origin, plus
// a CSP that blocks every network fetch unless the user clicks "Load images".
// sanitizeHtml() here is belt-and-braces — it strips the obvious active
// content so a bug in the frame can't turn into script execution.
// ---------------------------------------------------------------------------

const TEXT_TYPES = ['text/plain', 'text/html'];

/** A leaf's filename from Content-Disposition or Content-Type params. */
const filenameOf = (node) =>
  (node.dispositionParameters && (node.dispositionParameters.filename || node.dispositionParameters['filename*']))
  || (node.parameters && (node.parameters.name || node.parameters['name*']))
  || null;

const stripCid = (id) => (id ? String(id).trim().replace(/^<|>$/g, '') : null);

/**
 * Walk an imapflow bodyStructure. Returns
 *   { html: part|null, text: part|null, attachments: [...], inline: [...] }
 * where each part is { part, type, charset, size, filename, contentId }.
 * A single-part message has no `part` id — IMAP addresses its body as '1'.
 */
const walkParts = (structure) => {
  const out = { html: null, text: null, attachments: [], inline: [] };
  if (!structure) return out;

  const visit = (node, fallbackPart) => {
    if (!node) return;
    const type = String(node.type || '').toLowerCase();
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      node.childNodes.forEach((child, i) => visit(child, `${fallbackPart ? `${fallbackPart}.` : ''}${i + 1}`));
      return;
    }
    const leaf = {
      part: node.part || fallbackPart || '1',
      type,
      charset: node.parameters && node.parameters.charset ? String(node.parameters.charset) : null,
      size: Number(node.size) || 0,
      filename: filenameOf(node),
      contentId: stripCid(node.id),
      disposition: node.disposition ? String(node.disposition).toLowerCase() : null,
    };
    const isAttachment = leaf.disposition === 'attachment' || (!!leaf.filename && !TEXT_TYPES.includes(type));
    if (!isAttachment && type === 'text/html' && !out.html) { out.html = leaf; return; }
    if (!isAttachment && type === 'text/plain' && !out.text) { out.text = leaf; return; }
    // An image referenced from the HTML by Content-ID is part of the body, not
    // an attachment chip — unless the sender explicitly marked it attachment.
    if (leaf.contentId && type.startsWith('image/') && leaf.disposition !== 'attachment') {
      out.inline.push(leaf);
      return;
    }
    if (isAttachment || !TEXT_TYPES.includes(type)) {
      out.attachments.push({ ...leaf, filename: leaf.filename || `attachment-${leaf.part}` });
    }
  };

  visit(structure, '');
  return out;
};

/** Does this bodyStructure carry a real (non-inline) attachment? For the list icon. */
const hasAttachments = (structure) => walkParts(structure).attachments.length > 0;

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain text → minimal HTML: escaped, line breaks kept, bare links clickable. */
const textToHtml = (text) => {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(/\bhttps?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit">${linked}</div>`;
};

/**
 * Belt-and-braces stripping of active content. NOT a full sanitizer — the
 * sandboxed iframe is the guarantee (see the header comment).
 */
const sanitizeHtml = (html) => String(html || '')
  .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<script\b[^>]*>/gi, '')
  .replace(/<(iframe|frame|frameset|object|embed|applet|form|base|link)\b[\s\S]*?(<\/\1\s*>|>)/gi, '')
  .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
  .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/(href|src|action|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');

/** Does the HTML load anything from the network? Drives the "Images hidden" bar. */
const hasRemoteContent = (html) =>
  /<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html || '')
  || /url\(\s*["']?\s*(https?:)?\/\//i.test(html || '')
  || /\bbackground\s*=\s*["']?\s*(https?:)?\/\//i.test(html || '');

/** Replace cid:ID references with data: URIs from { contentId: dataUri }. */
const inlineCids = (html, map) => {
  if (!html || !map || !Object.keys(map).length) return html;
  return html.replace(/cid:([^"')\s>]+)/gi, (m, id) => {
    const key = stripCid(decodeURIComponent(id));
    return map[key] || m;
  });
};

/** imapflow envelope address list → [{ name, address }] with safe strings. */
const addressList = (list) => (Array.isArray(list) ? list : [])
  .filter((a) => a && (a.address || a.name))
  .map((a) => ({ name: a.name ? String(a.name) : '', address: a.address ? String(a.address).toLowerCase() : '' }));

/** Is this sender outside every allowed clinic domain? Drives the "External" tag. */
const isExternal = (address, domains) => {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return true;
  const d = String(address).slice(at + 1).toLowerCase();
  return !(domains || []).includes(d);
};

/** Special-use flag → the name the UI shows and the order folders sort in. */
const SPECIAL = {
  '\\Inbox': { key: 'inbox', label: 'Inbox', order: 0 },
  '\\Drafts': { key: 'drafts', label: 'Drafts', order: 2 },
  '\\Sent': { key: 'sent', label: 'Sent', order: 1 },
  '\\Archive': { key: 'archive', label: 'Archive', order: 3 },
  '\\Junk': { key: 'junk', label: 'Junk', order: 4 },
  '\\Trash': { key: 'trash', label: 'Trash', order: 5 },
};

/** imapflow list() rows → the folder rail. Hidden/non-selectable folders dropped. */
const shapeFolders = (rows) => (rows || [])
  .filter((f) => f && f.path && !(f.flags && (f.flags.has ? f.flags.has('\\Noselect') : [].concat(f.flags).includes('\\Noselect'))))
  .map((f) => {
    const special = f.path.toUpperCase() === 'INBOX' ? SPECIAL['\\Inbox'] : SPECIAL[f.specialUse] || null;
    return {
      path: f.path,
      name: special ? special.label : (f.name || f.path),
      special: special ? special.key : null,
      order: special ? special.order : 100,
      delimiter: f.delimiter || '/',
      messages: f.status && Number.isFinite(f.status.messages) ? f.status.messages : null,
      unseen: f.status && Number.isFinite(f.status.unseen) ? f.status.unseen : null,
    };
  })
  .sort((a, b) => (a.order - b.order) || a.path.localeCompare(b.path));

module.exports = {
  walkParts,
  hasAttachments,
  escapeHtml,
  textToHtml,
  sanitizeHtml,
  hasRemoteContent,
  inlineCids,
  addressList,
  isExternal,
  shapeFolders,
  stripCid,
};
