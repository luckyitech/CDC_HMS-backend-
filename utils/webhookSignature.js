const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Meta signs every webhook POST with X-Hub-Signature-256: 'sha256=<hex>', an
// HMAC-SHA256 of the RAW request body keyed by the app secret. We must verify
// it over the exact bytes Meta sent — which is why the webhook route is mounted
// with express.raw() BEFORE express.json() (any re-serialisation would change
// the bytes and break the signature). Comparison is constant-time.
// ---------------------------------------------------------------------------

const verifySignature = (rawBody, signatureHeader, appSecret) => {
  if (!appSecret || !signatureHeader || !rawBody) return false;
  const m = /^sha256=([a-f0-9]+)$/i.exec(String(signatureHeader).trim());
  if (!m) return false;

  const expected = crypto.createHmac('sha256', appSecret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
    .digest();
  let provided;
  try { provided = Buffer.from(m[1], 'hex'); } catch { return false; }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
};

module.exports = { verifySignature };
