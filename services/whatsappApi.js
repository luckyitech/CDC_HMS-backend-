const { getCommsConfig } = require('../utils/commsConfig');

// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API — a thin fetch wrapper (NO SDK, per A4). Plain HTTPS
// against graph.facebook.com with the clinic's own System User token. Every
// call reads the token + graph version from Settings (utils/commsConfig,
// cached), so callers never handle credentials.
//
// Errors are normalised to { code, userMessage } and thrown, so the controller
// can show something a human understands instead of Meta's raw JSON. One retry
// on a transport error (a dropped connection), never on a 4xx (that would just
// repeat a bad request).
// ---------------------------------------------------------------------------

// The Graph base. Overridable ONLY via env so a scripted fake Meta can stand in
// during verification; production never sets it and talks to Meta directly.
const GRAPH = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com';

const cfg = async () => {
  const c = await getCommsConfig({ redact: false });
  if (!c.accessToken) {
    const e = new Error('WhatsApp is not connected. Add the credentials in System Settings → WhatsApp.');
    e.code = 'not_configured';
    throw e;
  }
  return c;
};

// Friendly text for the Meta error codes staff will actually hit.
const META_ERROR_TEXT = {
  131047: 'This chat is outside the 24-hour window — send an approved template instead of a free message.',
  131026: 'The message could not be delivered — the number may not be on WhatsApp.',
  131051: 'This type of message is not supported for this number.',
  132000: 'The template does not match its approved format.',
  100:    'The request was rejected by WhatsApp (a parameter was missing or invalid).',
  190:    'The WhatsApp access token is invalid or has expired — an admin needs to refresh it in System Settings.',
  368:    'This number is temporarily blocked by WhatsApp for policy reasons.',
  80007:  'WhatsApp is rate-limiting the clinic number — try again shortly.',
};

const normaliseError = (payload, status) => {
  const err = payload && payload.error ? payload.error : {};
  const code = err.code || status || 'unknown';
  const message = META_ERROR_TEXT[code]
    || err.error_user_msg
    || err.message
    || `WhatsApp request failed (${code}).`;
  const e = new Error(message);
  e.code = code;
  e.userMessage = message;
  e.metaTitle = err.error_user_title || null;
  return e;
};

// One fetch with a single transport retry. `parse` false returns the Response.
const call = async (url, opts = {}, { retry = true, parse = true } = {}) => {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (netErr) {
    if (retry) return call(url, opts, { retry: false, parse });
    const e = new Error('Could not reach WhatsApp — check the server\'s internet connection.');
    e.code = 'network';
    throw e;
  }
  if (!parse) {
    if (!res.ok) throw normaliseError(await res.json().catch(() => ({})), res.status);
    return res;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw normaliseError(body, res.status);
  return body;
};

const authHeaders = (c) => ({ Authorization: `Bearer ${c.accessToken}` });
const jsonHeaders = (c) => ({ ...authHeaders(c), 'Content-Type': 'application/json' });

// --- Sending ---------------------------------------------------------------

const sendText = async (phoneNumberId, to, text) => {
  const c = await cfg();
  return call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: jsonHeaders(c),
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
  });
};

const sendTemplate = async (phoneNumberId, to, name, language = 'en', components = []) => {
  const c = await cfg();
  return call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: jsonHeaders(c),
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
    }),
  });
};

// Upload bytes to Meta, then send them as a document/image. We keep the exact
// bytes ourselves (private/comms/…); this only hands Meta a copy to deliver.
const uploadMedia = async (phoneNumberId, buffer, mime, filename) => {
  const c = await cfg();
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mime }), filename || 'file');
  const body = await call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}/media`, {
    method: 'POST', headers: authHeaders(c), body: form,
  });
  return body.id;
};

const sendMedia = async (phoneNumberId, to, { buffer, mime, filename, caption, kind = 'document' }) => {
  const mediaId = await uploadMedia(phoneNumberId, buffer, mime, filename);
  const c = await cfg();
  const media = { id: mediaId };
  if (kind === 'document') { media.filename = filename; if (caption) media.caption = caption; }
  else if (caption) media.caption = caption;
  return call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST', headers: jsonHeaders(c),
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: kind, [kind]: media }),
  });
};

const markRead = async (phoneNumberId, messageId) => {
  const c = await cfg();
  return call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST', headers: jsonHeaders(c),
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch((e) => {
    // A read receipt is best-effort — an expired-message id must not fail a UI action.
    console.error('WhatsApp.markRead (non-fatal):', e.message);
    return null;
  });
};

// --- Media download (inbound) ---------------------------------------------

const getMediaUrl = async (mediaId) => {
  const c = await cfg();
  const body = await call(`${GRAPH}/${c.graphVersion}/${mediaId}`, { headers: authHeaders(c) });
  return body.url;
};

/** Fetch a media URL (bearer-authorised) as a Response for streaming. */
const fetchMedia = async (url) => {
  const c = await cfg();
  return call(url, { headers: authHeaders(c) }, { parse: false });
};

// --- Management ------------------------------------------------------------

const getPhoneNumbers = async (wabaId) => {
  const c = await cfg();
  const body = await call(`${GRAPH}/${c.graphVersion}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`, { headers: authHeaders(c) });
  return body.data || [];
};

const getPhoneNumber = async (phoneNumberId) => {
  const c = await cfg();
  return call(`${GRAPH}/${c.graphVersion}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { headers: authHeaders(c) });
};

const getTemplates = async (wabaId) => {
  const c = await cfg();
  const body = await call(`${GRAPH}/${c.graphVersion}/${wabaId}/message_templates?fields=name,language,category,status,components&limit=200`, { headers: authHeaders(c) });
  return body.data || [];
};

/** Subscribe our app to the WABA's webhooks (idempotent; called from Test connection). */
const subscribeApp = async (wabaId) => {
  const c = await cfg();
  return call(`${GRAPH}/${c.graphVersion}/${wabaId}/subscribed_apps`, { method: 'POST', headers: authHeaders(c) });
};

module.exports = {
  sendText, sendTemplate, sendMedia, uploadMedia, markRead,
  getMediaUrl, fetchMedia, getPhoneNumbers, getPhoneNumber, getTemplates, subscribeApp,
  normaliseError,
};
