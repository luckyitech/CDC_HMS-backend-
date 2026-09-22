const { getCommsConfig } = require('../utils/commsConfig');

// ---------------------------------------------------------------------------
// Meta Messenger + Instagram send API — a thin fetch wrapper (NO SDK, per A4),
// the Messenger-platform sibling of services/whatsappApi.js.
//
// Both Facebook Messenger and Instagram messaging go through the SAME endpoint,
// POST /me/messages, authenticated with the connected Facebook PAGE access
// token (an Instagram professional account is messaged via the Page it is
// linked to, using that Page's token). So one send path serves both channels;
// the recipient id is a PSID (Messenger) or IGSID (Instagram) that arrived on
// the inbound webhook — never a phone number.
//
// Credentials come from Settings (utils/commsConfig, encrypted) exactly like
// WhatsApp, so callers never touch the token. Errors are normalised to
// { code, userMessage } and thrown.
// ---------------------------------------------------------------------------

// Overridable ONLY via env so a scripted fake Meta can stand in during
// verification; production never sets it and talks to Meta directly.
const GRAPH = process.env.META_GRAPH_BASE || process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com';

const cfg = async () => {
  const c = await getCommsConfig({ redact: false });
  if (!c.pageAccessToken) {
    const e = new Error('Messenger/Instagram is not connected. Add the Page access token in System Settings → WhatsApp.');
    e.code = 'not_configured';
    throw e;
  }
  return c;
};

// Friendly text for the Messenger/Instagram error codes staff will actually hit.
const META_ERROR_TEXT = {
  10:    'This message is outside the allowed window — you can only reply within 24 hours of the person’s last message.',
  551:   'This person is not available to receive messages right now.',
  200:   'The Page is missing a permission needed to send this message.',
  190:   'The Page access token is invalid or has expired — an admin needs to refresh it in System Settings.',
  613:   'Messenger is rate-limiting the Page — try again shortly.',
};

const normaliseError = (payload, status) => {
  const err = (payload && payload.error) ? payload.error : {};
  const code = err.code || status || 'unknown';
  const message = META_ERROR_TEXT[code]
    || err.error_user_msg
    || err.message
    || `The message could not be sent (${code}).`;
  const e = new Error(message);
  e.code = code;
  e.userMessage = message;
  e.metaTitle = err.error_user_title || null;
  return e;
};

// One fetch with a single transport retry (never on a 4xx). `parse` false
// returns the raw Response (used for streaming an attachment download).
const call = async (url, opts = {}, { retry = true, parse = true } = {}) => {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (netErr) {
    if (retry) return call(url, opts, { retry: false, parse });
    const e = new Error('Could not reach Meta — check the server’s network connection.');
    e.code = 'network';
    e.userMessage = e.message;
    throw e;
  }
  if (!parse) return res;
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw normaliseError(body, res.status);
  return body;
};

// Send a plain text reply. `to` is the PSID/IGSID from the inbound webhook.
// Returns Meta's { recipient_id, message_id }.
const sendText = async (to, text) => {
  const c = await cfg();
  const url = `${GRAPH}/${c.graphVersion}/me/messages?access_token=${encodeURIComponent(c.pageAccessToken)}`;
  return call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: String(to) }, messaging_type: 'RESPONSE', message: { text: String(text) } }),
  });
};

// Download an inbound attachment. Messenger/IG give a direct (signed) CDN URL on
// the webhook, so — unlike WhatsApp — there is no media-id lookup step.
const fetchAttachment = (url) => call(url, {}, { parse: false });

module.exports = { sendText, fetchAttachment, GRAPH };
