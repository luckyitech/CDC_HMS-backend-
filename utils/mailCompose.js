const addressparser = require('nodemailer/lib/addressparser');
const { escapeHtml, sanitizeHtml } = require('./mailRender');

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 2 — pure helpers for composing mail: recipients,
// reply/forward subjects and recipient lists, threading headers, the quoted
// original, and the plain-text alternative. No I/O, so every function is
// unit-tested directly (tests/mailCompose.test.js).
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>,;"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const MAX_RECIPIENTS = 50; // one.com allows 250 recipients / 5 min; a person's email never needs more

const norm = (a) => String(a || '').trim().toLowerCase();

/**
 * Anything the composer sends for a recipient field — an array of strings or
 * { name, address } objects, or one comma/semicolon separated string — into
 * { ok: [{ name, address }], bad: [raw strings] }. Duplicates removed.
 */
const parseRecipients = (input) => {
  const raw = [];
  const push = (v) => {
    if (!v) return;
    if (typeof v === 'object') {
      raw.push(v.name ? `"${String(v.name).replace(/"/g, '')}" <${v.address || ''}>` : String(v.address || ''));
    } else {
      raw.push(String(v));
    }
  };
  (Array.isArray(input) ? input : [input]).forEach(push);

  const ok = []; const bad = []; const seen = new Set();
  for (const chunk of raw) {
    const parsed = addressparser(chunk.replace(/;/g, ','), { flatten: true });
    if (!parsed.length && chunk.trim()) bad.push(chunk.trim());
    for (const p of parsed) {
      const address = norm(p.address);
      if (!address && !p.name) continue;
      if (!EMAIL_RE.test(address)) { bad.push((p.address || p.name || '').trim()); continue; }
      if (seen.has(address)) continue;
      seen.add(address);
      ok.push({ name: String(p.name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120), address });
    }
  }
  return { ok, bad: bad.filter(Boolean) };
};

const domainOf = (address) => {
  const a = norm(address);
  const at = a.lastIndexOf('@');
  return at > 0 ? a.slice(at + 1) : '';
};

/** For the metadata-only `sent` audit row: how many recipients, which domains. Never addresses. */
const recipientSummary = (lists) => {
  const all = lists.flat();
  return { count: all.length, domains: [...new Set(all.map((r) => domainOf(r.address)).filter(Boolean))].sort() };
};

/** "Re: x" / "Fwd: x", without stacking prefixes. */
const prefixSubject = (subject, mode) => {
  const s = String(subject || '').trim();
  const stripped = s.replace(/^((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '');
  if (mode === 'forward') return `Fwd: ${stripped}`.trim();
  return `Re: ${stripped}`.trim();
};

/**
 * Who a reply goes to.
 *   reply    → Reply-To if set, else From
 *   replyAll → that, plus every To and Cc — minus the user's own address
 *   forward  → nobody
 * If the message was one the user sent (their own address in From), a reply
 * goes back to the original To list, as mail apps do.
 */
const replyRecipients = (msg, mode, ownAddress) => {
  const own = norm(ownAddress);
  if (mode === 'forward') return { to: [], cc: [] };
  const fromMe = msg.from && norm(msg.from.address) === own;
  let to;
  if (fromMe) to = [...(msg.to || [])];
  else to = (msg.replyTo && msg.replyTo.length) ? [...msg.replyTo] : (msg.from ? [msg.from] : []);
  let cc = [];
  if (mode === 'replyAll') {
    cc = [...(fromMe ? [] : (msg.to || [])), ...(msg.cc || [])];
  }
  const seen = new Set();
  const keep = (a) => {
    const addr = norm(a && a.address);
    if (!addr || addr === own || seen.has(addr)) return false;
    seen.add(addr);
    return true;
  };
  const clean = (a) => ({ name: a.name || '', address: norm(a.address) });
  to = to.filter(keep).map(clean);
  cc = cc.filter(keep).map(clean);
  return { to, cc };
};

const MSGID_RE = /<[^<>\s]+>/g;

/** A References header value → a list of <message-ids>. */
const parseIdList = (value) => (String(value || '').match(MSGID_RE) || []);

/** In-Reply-To + References for a reply. References is capped (headers have limits). */
const threadHeaders = ({ messageId, references }) => {
  const id = parseIdList(messageId)[0] || null;
  if (!id) return { inReplyTo: null, references: parseIdList(references).slice(-20) };
  const refs = parseIdList(references).filter((r) => r !== id);
  return { inReplyTo: id, references: [...refs, id].slice(-20) };
};

const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

const fmtDate = (d) => {
  const date = d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi',
  });
};

/**
 * The original message, quoted under the reply (or introduced as a forward).
 * `html` is the already-sanitised body the reading pane shows.
 */
const quoteOriginal = (msg, mode) => {
  // Inline images were embedded as data: URIs for reading; they would bloat
  // every reply, so the quote drops them (the forward still carries files).
  const body = sanitizeHtml(msg.html || '').replace(/<img\b[^>]*\bsrc\s*=\s*["']?\s*data:[^>]*>/gi, '');
  if (mode === 'forward') {
    const rows = [
      ['From', who(msg.from)],
      ['Date', fmtDate(msg.date)],
      ['Subject', msg.subject || ''],
      ['To', (msg.to || []).map(who).join(', ')],
      ...(msg.cc && msg.cc.length ? [['Cc', msg.cc.map(who).join(', ')]] : []),
    ];
    const head = rows.map(([k, v]) => `<b>${k}:</b> ${escapeHtml(v)}`).join('<br>');
    return `<div data-hms-quote="forward"><p>---------- Forwarded message ----------<br>${head}</p>${body}</div>`;
  }
  const line = `On ${escapeHtml(fmtDate(msg.date))}, ${escapeHtml(who(msg.from))} wrote:`;
  return `<div data-hms-quote="reply"><p>${line}</p><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body}</blockquote></div>`;
};

const decodeEntities = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** HTML → a readable plain-text alternative (for mail clients that want text). */
const htmlToText = (html) => {
  let s = String(html || '');
  s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    const t = text.replace(/<[^>]+>/g, '').trim();
    return t && t !== href ? `${t} (${href})` : href;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|h[1-6]|tr|blockquote|ul|ol)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

const QUOTE_MARK = /<div\b[^>]*data-hms-quote=/i;

/**
 * A saved draft's HTML → { body, quote }: the part the user edits, and the
 * quoted original (shown read-only in the sandboxed frame, never in the
 * editable area — a sender's <style> must not restyle the HMS). Styles,
 * <head> and document wrappers are dropped from the editable part.
 */
const splitDraftHtml = (html) => {
  let s = String(html || '');
  const inner = s.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  if (inner) s = inner[1];
  s = s.replace(/<(style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/?(html|body|meta|link)\b[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, '');
  const m = s.match(QUOTE_MARK);
  const trimBody = (b) => b.trim().replace(/(<br\s*\/?>\s*)+$/i, '').trim();
  if (!m) return { body: trimBody(s), quote: '' };
  return { body: trimBody(s.slice(0, m.index)), quote: s.slice(m.index).trim() };
};

/** The body the HMS sends: what the user wrote, then the quoted original. */
const joinBody = (html, quotedHtml) => {
  const quote = quotedHtml ? sanitizeHtml(String(quotedHtml)).slice(0, 3 * 1024 * 1024) : '';
  return `${String(html || '')}${quote ? `<br>${quote}` : ''}`;
};

/**
 * The signature added under what the user wrote, on every message they send:
 * their own lines (from their email settings) above the clinic block (from
 * System Settings → Email). Table layout with inline styles — the only thing
 * every mail app renders the same. `logoSrc` is `cid:…` when sending (the
 * image travels inside the message, so it shows without "load images") or a
 * data: URI for the in-HMS preview.
 */
const signatureBlock = ({ personalHtml, clinic, logoSrc }) => {
  const c = clinic || {};
  const personal = sanitizeHtml(String(personalHtml || '')).trim();
  const esc = (v) => escapeHtml(String(v || '').trim());
  const url = String(c.website || '').trim();
  const href = url ? (/^https?:\/\//i.test(url) ? url : `https://${url}`) : '';
  const contactBits = [
    c.phone ? esc(c.phone) : '',
    c.email ? `<a href="mailto:${esc(c.email)}" style="color:#4b5563;text-decoration:none">${esc(c.email)}</a>` : '',
    href ? `<a href="${esc(href)}" style="color:#1d4ed8;text-decoration:none">${esc(url.replace(/^https?:\/\//i, ''))}</a>` : '',
  ].filter(Boolean);
  const hasClinic = !!(c.clinicName || c.address || contactBits.length);
  if (!personal && !hasClinic && !logoSrc) return '';

  const font = 'font-family:Arial,Helvetica,sans-serif;';
  const lines = [
    personal ? `<div style="${font}font-size:14px;color:#111827;line-height:1.45">${personal}</div>` : '',
    c.clinicName ? `<div style="${font}font-size:14px;font-weight:bold;color:#1d4ed8;margin-top:${personal ? '6px' : '0'}">${esc(c.clinicName)}</div>` : '',
    c.address ? `<div style="${font}font-size:12px;color:#4b5563">${esc(c.address)}</div>` : '',
    contactBits.length ? `<div style="${font}font-size:12px;color:#4b5563">${contactBits.join(' &middot; ')}</div>` : '',
  ].filter(Boolean).join('');
  const logoCell = logoSrc
    ? `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="${escapeHtml(logoSrc)}" alt="${esc(c.clinicName || 'Logo')}" width="64" height="64" style="display:block;width:64px;height:64px;border:0"></td>`
    : '';
  const note = c.confidentialityOn && String(c.confidentialityText || '').trim()
    ? `<div style="${font}font-size:11px;color:#9ca3af;line-height:1.4;margin-top:10px;max-width:560px">${esc(c.confidentialityText)}</div>`
    : '';
  return `<div data-hms-signature="1" style="margin-top:18px">`
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>'
    + `${logoCell}<td style="vertical-align:middle;border-left:2px solid #bfdbfe;padding-left:12px">${lines}</td>`
    + `</tr></table>${note}</div>`;
};

/** Clean the composer's HTML before it leaves the HMS. The user wrote it, but it may carry pasted content. */
const outgoingHtml = (html) => {
  const body = sanitizeHtml(String(html || '')).slice(0, 2 * 1024 * 1024);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${body}</body></html>`;
};

module.exports = {
  MAX_RECIPIENTS,
  EMAIL_RE,
  parseRecipients,
  domainOf,
  recipientSummary,
  prefixSubject,
  replyRecipients,
  parseIdList,
  threadHeaders,
  quoteOriginal,
  htmlToText,
  outgoingHtml,
  splitDraftHtml,
  joinBody,
  signatureBlock,
};
