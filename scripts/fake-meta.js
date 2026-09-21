const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// A scripted stand-in for Meta's Graph API, for verifying the Communications
// Inbox without touching Meta. Point the code at it with
// WHATSAPP_GRAPH_BASE=http://127.0.0.1:<port>. It:
//   • serves GET /{v}/{mediaId}                 → { url: <self>/dl/{mediaId} }
//   • serves GET /dl/{mediaId}                  → the bytes registered for it
//   • accepts POST /{v}/{phoneNumberId}/messages → { messages:[{ id }] }, recorded
//   • accepts POST /{v}/{phoneNumberId}/media    → { id }, recorded
//   • serves GET /{v}/{wabaId}/message_templates → { data:[…] }
//   • records every call in `server.calls` for assertions
//
// It also builds signed inbound webhook payloads (signPayload / inboundText /
// inboundDocument / statusUpdate) so a test can drive the real webhook route or
// processWebhook directly.
// ---------------------------------------------------------------------------

const start = ({ templates = [] } = {}) => {
  const media = new Map();       // mediaId -> { buffer, mime }
  const calls = [];              // every request, for assertions
  let msgSeq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url.split('?')[0];
      calls.push({ method: req.method, url, body: raw.toString('utf8') });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      // media download
      let m = url.match(/^\/dl\/(.+)$/);
      if (m && req.method === 'GET') {
        const entry = media.get(m[1]);
        if (!entry) { res.writeHead(404); return res.end('no media'); }
        res.writeHead(200, { 'Content-Type': entry.mime });
        return res.end(entry.buffer);
      }
      // media URL lookup: GET /{v}/{mediaId}
      m = url.match(/^\/v\d+\.\d+\/([^/]+)$/);
      if (m && req.method === 'GET') {
        return send(200, { url: `http://127.0.0.1:${server.address().port}/dl/${m[1]}`, mime_type: (media.get(m[1]) || {}).mime });
      }
      // send message / upload media / templates
      m = url.match(/^\/v\d+\.\d+\/([^/]+)\/(messages|media)$/);
      if (m && req.method === 'POST') {
        if (m[2] === 'media') return send(200, { id: `uploaded-${++msgSeq}` });
        return send(200, { messages: [{ id: `wamid.OUT${++msgSeq}` }] });
      }
      if (/\/message_templates$/.test(url) && req.method === 'GET') return send(200, { data: templates });
      if (/\/subscribed_apps$/.test(url) && req.method === 'POST') return send(200, { success: true });
      return send(200, {});
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        registerMedia: (id, buffer, mime) => media.set(id, { buffer, mime }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
};

// --- payload builders -------------------------------------------------------

const signPayload = (raw, appSecret) =>
  `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(raw)).digest('hex')}`;

const envelope = (phoneNumberId, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: String(phoneNumberId) }, ...value } }] }],
});

const inboundText = ({ phoneNumberId, from, id, text, name = 'Sender', ts = Math.floor(Date.now() / 1000) }) =>
  envelope(phoneNumberId, {
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }],
  });

const inboundDocument = ({ phoneNumberId, from, id, mediaId, mime = 'application/pdf', filename = 'report.pdf', caption, name = 'Sender', ts = Math.floor(Date.now() / 1000) }) =>
  envelope(phoneNumberId, {
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id, timestamp: String(ts), type: 'document', document: { id: mediaId, mime_type: mime, filename, caption } }],
  });

const statusUpdate = ({ phoneNumberId, id, status, ts = Math.floor(Date.now() / 1000), billable, category, errorCode, errorTitle }) =>
  envelope(phoneNumberId, {
    statuses: [{
      id, status, timestamp: String(ts), recipient_id: '254700000000',
      ...(billable != null || category ? { pricing: { billable, category } } : {}),
      ...(errorCode ? { errors: [{ code: errorCode, title: errorTitle }] } : {}),
    }],
  });

module.exports = { start, signPayload, envelope, inboundText, inboundDocument, statusUpdate };
