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

// The sender's display name, for labelling a thread in the Inbox. Unlike
// WhatsApp (which sends a contact name with every message), Messenger and
// Instagram send only an opaque PSID/IGSID, so without this every thread reads
// "Facebook Page". Needs the app feature "Business Asset User Profile Access".
// BEST-EFFORT: any failure (feature missing, the person's privacy settings,
// token, network, 5 s timeout) returns null and the thread stays unnamed —
// a message must never be lost or held up over a name.
const PROFILE_FIELDS = { messenger: 'first_name,last_name', instagram: 'name,username' };

const profileNameFrom = (p) => {
  if (!p || typeof p !== 'object') return null;
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || String(p.name || '').trim();
  const name = full || (p.username ? `@${p.username}` : '');
  return name ? name.slice(0, 255) : null;
};

const fetchProfileName = async (userId, channelType) => {
  const fields = PROFILE_FIELDS[channelType];
  if (!fields || !userId) return null;
  try {
    const c = await cfg();
    const url = `${GRAPH}/${c.graphVersion}/${encodeURIComponent(String(userId))}?fields=${fields}&access_token=${encodeURIComponent(c.pageAccessToken)}`;
    return profileNameFrom(await call(url, { signal: AbortSignal.timeout(5000) }, { retry: false }));
  } catch {
    return null;
  }
};

// Download an inbound attachment. Messenger/IG give a direct (signed) CDN URL on
// the webhook, so — unlike WhatsApp — there is no media-id lookup step.
const fetchAttachment = (url) => call(url, {}, { parse: false });

module.exports = { sendText, fetchAttachment, fetchProfileName, profileNameFrom, GRAPH };
