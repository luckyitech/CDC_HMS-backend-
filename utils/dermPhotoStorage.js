// =====================================================================
// Dermatology photos — where they live and how they are cleaned (Phase 2,
// 7 Oct 2026).
//
// private/derm-photos/ — git-ignored, NEVER served statically. Read only
// through GET /api/derm/photos/:id/file (login + doctor / derm.record), and
// every read is logged (DermPhotoViews).
//
// Skin photos are the most sensitive images the HMS holds, so a photo is
// accepted ONLY as a JPEG (the browser re-encodes every picture to JPEG
// before upload, which already drops the camera's metadata) and the server
// strips the metadata segments again here — EXIF (GPS position, camera, time)
// in APP1, IPTC in APP13 — so a location can never ride along in the file.
// =====================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DERM_PHOTO_DIR = path.join(ROOT, 'private', 'derm-photos');
const MAX_BYTES = 15 * 1024 * 1024;

const ensureDermPhotoDir = () => {
  if (!fs.existsSync(DERM_PHOTO_DIR)) fs.mkdirSync(DERM_PHOTO_DIR, { recursive: true });
  return DERM_PHOTO_DIR;
};

/** The file on disk for a stored name, or null. Only the NAME is trusted. */
const resolveDermPhoto = (name) => {
  const n = String(name || '').split(/[\\/]/).pop();
  if (!n || n === '.' || n === '..') return null;
  const candidate = path.join(DERM_PHOTO_DIR, n);
  if (path.dirname(candidate) !== DERM_PHOTO_DIR) return null;
  return fs.existsSync(candidate) ? candidate : null;
};

const isJpeg = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;

// Segments dropped from the header: APP1 (EXIF / XMP), APP12, APP13 (IPTC /
// Photoshop), COM (comments). JFIF (APP0), ICC colour (APP2) and Adobe
// (APP14) stay — they change how the picture looks, not who or where.
const DROP = new Set([0xE1, 0xEC, 0xED, 0xFE]);

/**
 * A JPEG with its metadata segments removed, and its pixel size.
 * Throws on anything that is not a well-formed JPEG header.
 * @returns {{ buffer: Buffer, width: number|null, height: number|null }}
 */
const stripJpeg = (buf) => {
  if (!isJpeg(buf)) throw new Error('NOT_JPEG');
  const out = [buf.subarray(0, 2)];
  let i = 2;
  let width = null; let height = null;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) throw new Error('BAD_JPEG');
    const marker = buf[i + 1];
    if (marker === 0xFF) { i += 1; continue; }                  // fill byte
    if (marker === 0xDA) { out.push(buf.subarray(i)); break; }   // start of scan: rest is image data
    if (marker === 0xD9) { out.push(buf.subarray(i)); break; }   // end of image
    if (marker >= 0xD0 && marker <= 0xD7) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) throw new Error('BAD_JPEG');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('BAD_JPEG');
    // Start-of-frame segments carry the size (not DHT C4, JPG C8, DAC CC).
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    if (!DROP.has(marker)) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return { buffer: Buffer.concat(out), width, height };
};

/** True when a JPEG still carries an EXIF / IPTC segment (used by the tests). */
const hasMetadata = (buf) => {
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xFF) {
    const marker = buf[i + 1];
    if (marker === 0xDA || marker === 0xD9) return false;
    if (DROP.has(marker)) return true;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return false;
};

/**
 * The doctor's marker — an ellipse in 0…1 picture coordinates, showing WHICH
 * mark on the photo is the finding. Never a measurement (photos have no scale).
 * Returns the cleaned marker, null for none, or undefined when invalid.
 */
const cleanMarker = (m) => {
  if (m === undefined || m === null || m === '') return null;
  let v = m;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const k of ['cx', 'cy', 'rx', 'ry']) {
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
    out[k] = Math.round(n * 10000) / 10000;
  }
  if (out.rx < 0.005 || out.ry < 0.005) return undefined;
  return out;
};

module.exports = { DERM_PHOTO_DIR, MAX_BYTES, ensureDermPhotoDir, resolveDermPhoto, isJpeg, stripJpeg, hasMetadata, cleanMarker };
