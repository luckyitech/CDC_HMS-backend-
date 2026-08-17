const crypto = require('crypto');
const { error } = require('../utils/response');

// HMIS V4 — machine-to-machine auth for the DICOM bridge.
//
// The bridge (clinic PC) is headless and cannot hold a user session, so the
// ingest route authenticates with a long random shared secret instead of a JWT:
// header `x-ingest-key` checked against process.env.INGEST_API_KEY.
//
// Properties:
// - No DB credentials and no user account on the clinic PC.
// - Rotation = change the env var on both machines, restart both.
// - Constant-time comparison to avoid timing side-channels.
// - If INGEST_API_KEY is unset, ingest is disabled outright (fail closed).
const ingestAuth = (req, res, next) => {
  const configured = process.env.INGEST_API_KEY;
  if (!configured) {
    return error(res, 'Ultrasound ingest is not configured on this server.', 503);
  }

  const provided = req.headers['x-ingest-key'];
  if (!provided) {
    return error(res, 'Missing ingest key.', 401);
  }

  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(configured));
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    return error(res, 'Invalid ingest key.', 401);
  }

  next();
};

module.exports = ingestAuth;
