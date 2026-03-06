const express = require('express');
const router = express.Router();
const { addClient } = require('../utils/sseManager');

// GET /api/sse — SSE connection endpoint
// Unauthenticated: sends only a notification event (no patient data).
// The client re-fetches actual data via the authenticated REST API on receipt.
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addClient(res);

  // Keep-alive ping every 25 s to prevent proxy/firewall timeouts
  const ping = setInterval(() => {
    try {
      res.write(':ping\n\n');
    } catch (_) {
      clearInterval(ping);
    }
  }, 25000);

  res.on('close', () => clearInterval(ping));
});

module.exports = router;
