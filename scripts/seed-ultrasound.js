/**
 * HMIS V4 — seed sample ultrasound images so the UI can be verified WITHOUT
 * the HS70A machine or the bridge.
 *
 * Usage:  node scripts/seed-ultrasound.js <UHID>
 *
 * Creates 8 rows: 7 matched to <UHID> (one flagged multiframe) + 1 unassigned
 * (unknown dicomPatientId → lands in the Unassigned queue). PNG files are
 * generated locally (no dependencies) into uploads/ultrasound/.
 *
 * NEVER run against production.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../models');

const { UltrasoundImage, Patient } = db;

// ------------------------------------------------------------------
// Minimal PNG encoder (grayscale, no deps) — good enough for seeding
// ------------------------------------------------------------------
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Renders a WxH grayscale test pattern (diagonal gradient + index stripes)
const makePng = (w, h, index) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  // compression/filter/interlace = 0

  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const stripe = Math.floor(x / 40) % 2 === index % 2 ? 30 : 0;
      raw[y * (w + 1) + 1 + x] = Math.min(255, ((x + y) / (w + h)) * 255 + stripe) | 0;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// ------------------------------------------------------------------
const main = async () => {
  const uhid = process.argv[2];
  if (!uhid) {
    console.error('Usage: node scripts/seed-ultrasound.js <UHID>');
    process.exit(1);
  }

  const patient = await Patient.findOne({ where: { uhid } });
  if (!patient) {
    console.error(`Patient with UHID '${uhid}' not found.`);
    process.exit(1);
  }

  const uploadDir = path.join(__dirname, '..', 'uploads', 'ultrasound');
  fs.mkdirSync(uploadDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (let i = 1; i <= 8; i++) {
    const unassigned = i === 8;               // last one: unknown patient id
    const isMultiframe = i === 7;             // one cine-clip middle frame
    const fname = crypto.randomBytes(16).toString('hex') + '.png';
    const fpath = path.join(uploadDir, fname);
    fs.writeFileSync(fpath, makePng(640, 480, i));

    rows.push({
      PatientId: unassigned ? null : patient.id,
      dicomPatientId: unassigned ? 'UNKNOWN-999' : uhid,
      sopInstanceUid: `1.2.826.0.1.3680043.SEED.${Date.now()}.${i}`,
      studyDate: today,
      studyDescription: unassigned ? 'Abdomen (seed, unmatched)' : `Abdomen view ${i} (seed)`,
      isMultiframe,
      fileName: `US_seed_${String(i).padStart(2, '0')}.png`,
      filePath: fpath,
      fileUrl: `/uploads/ultrasound/${fname}`,
      status: unassigned ? 'Unassigned' : 'Matched',
      receivedAt: new Date(Date.now() - (8 - i) * 60000), // 1 min apart
    });
  }

  await UltrasoundImage.bulkCreate(rows);
  console.log(`Seeded ${rows.length} ultrasound images:`);
  console.log(`  7 matched to ${uhid} (1 multiframe), 1 unassigned (UNKNOWN-999).`);
  console.log('Open the patient chart → Ultrasound tab to verify.');
  process.exit(0);
};

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
