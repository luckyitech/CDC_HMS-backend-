const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const { verifySignature } = require('../utils/webhookSignature');
const { getCommsConfig } = require('../utils/commsConfig');
const { processWebhook } = require('../services/whatsappInbound');
const { webhookLimiter } = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
// Meta WhatsApp webhook — PUBLIC (Meta calls it), so it has its OWN limiter and
// is mounted in app.js BEFORE express.json() and the general limiter: Meta
// signs the RAW body, and any re-serialisation would break the signature.
//
//   GET  — the one-time verification handshake (hub.mode / hub.verify_token /
//          hub.challenge). Echo the challenge only on a constant-time token
//          match; 403 otherwise; 503 until an admin has configured WhatsApp.
//   POST — a signed event. Verify X-Hub-Signature-256 over the raw bytes; a bad
//          or missing signature is 401 (never 200 — a 200 tells Meta we
//          accepted it). A valid event is acknowledged with 200 IMMEDIATELY and
//          processed after the response, idempotently.
// ---------------------------------------------------------------------------

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// A rate-limited log so an unconfigured/mis-signed flood cannot fill the log.
let lastNoticeAt = 0;
const notice = (msg) => {
  const now = Date.now();
  if (now - lastNoticeAt > 60_000) { lastNoticeAt = now; console.error(`[Comms] webhook: ${msg}`); }
};

router.get('/', webhookLimiter, async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const cfg = await getCommsConfig({ redact: false });
    if (!cfg.verifyToken) return res.status(503).send('not configured');
    if (mode === 'subscribe' && safeEqual(token, cfg.verifyToken)) {
      return res.status(200).send(String(challenge == null ? '' : challenge));
    }
    return res.sendStatus(403);
  } catch (err) {
    console.error('[Comms] webhook verify error:', err.message);
    return res.sendStatus(500);
  }
});

router.post('/', webhookLimiter, express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  let cfg;
  try {
    cfg = await getCommsConfig({ redact: false });
  } catch {
    notice('config read failed');
    return res.sendStatus(200);   // ack so Meta does not hammer retries
  }
  if (!cfg.appSecret) {
    notice('event received but WhatsApp is not configured');
    return res.sendStatus(200);
  }

  const signature = req.get('X-Hub-Signature-256');
  const raw = req.body;   // Buffer, from express.raw
  if (!verifySignature(raw, signature, cfg.appSecret)) {
    notice('signature verification failed');
    return res.sendStatus(401);
  }

  // Acknowledge first, then process — Meta expects a fast 200 and will retry
  // for up to 7 days if it does not get one.
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const payload = JSON.parse(raw.toString('utf8'));
      await processWebhook(payload);
    } catch (err) {
      console.error('[Comms] webhook processing error:', err.message);
    }
  });
});

module.exports = router;
