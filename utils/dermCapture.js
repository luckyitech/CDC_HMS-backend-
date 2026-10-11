// Dermatology — area photos and the phone hand-off (8 Oct 2026). Pure rules.
const crypto = require('crypto');
const { isRegion } = require('./dermRegions');

const CAPTURE_MINUTES = 10;          // a QR link lives this long
const MAX_PHOTOS_PER_SESSION = 40;   // one hand-off cannot flood the record

const newToken = () => crypto.randomBytes(24).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
const sameHash = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * The areas sent with a photo or a session: a JSON array (or array) of known
 * region ids, de-duplicated. `allowed` (optional) narrows them to a set.
 * Returns { ok, value } or { ok: false, message }.
 */
const cleanAreas = (raw, allowed = null) => {
  let list = raw;
  if (raw === undefined || raw === null || raw === '') list = [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return { ok: false, message: 'The photo\'s areas could not be read' }; } }
  if (!Array.isArray(list) || list.some((r) => typeof r !== 'string')) return { ok: false, message: 'The photo\'s areas could not be read' };
  const value = [...new Set(list.map((r) => r.trim()).filter(Boolean))];
  if (value.some((r) => !isRegion(r))) return { ok: false, message: 'Unknown body area' };
  if (allowed && value.some((r) => !allowed.includes(r))) return { ok: false, message: 'A photo can only be attached to the chosen areas' };
  return { ok: true, value };
};

/** Why a session can no longer be used, or null. */
const sessionProblem = (s, now = new Date()) => {
  if (!s) return [404, 'This link is not valid'];
  if (s.closedAt) return [410, 'This link was closed on the computer'];
  if (new Date(s.expiresAt) <= now) return [410, 'This link has expired — show a new QR code on the computer'];
  if (s.photoCount >= MAX_PHOTOS_PER_SESSION) return [409, 'This link has taken as many photos as it may'];
  return null;
};

const splitAreas = (v) => (v ? String(v).split(',').filter(Boolean) : []);

module.exports = { CAPTURE_MINUTES, MAX_PHOTOS_PER_SESSION, newToken, hashToken, sameHash, cleanAreas, sessionProblem, splitAreas };
