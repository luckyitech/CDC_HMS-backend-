// Code128 barcode → PNG buffer. From scratch, zero dependencies —
// compression comes from Node's built-in zlib.
//
// Used by the barcode email: mail clients strip inline SVG, so the emailed
// card embeds a PNG (cid attachment). A barcode is the simplest possible
// image — vertical black/white columns, every scanline identical — so a
// minimal grayscale PNG encoder is ~60 lines.
//
// NOTE: the Code128 pattern table is intentionally duplicated from the
// frontend's cdc-hms/src/utils/code128.js — the two repos are separate, so
// they cannot share a module. If one changes, change both (the table is
// fixed spec data, so in practice it never changes).

const zlib = require('zlib');

const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213',
  '122312', '132212', '221213', '221312', '231212', '112232', '122132',
  '122231', '113222', '123122', '123221', '223211', '221132', '221231',
  '213212', '223112', '312131', '311222', '321122', '321221', '312212',
  '322112', '322211', '212123', '212321', '232121', '111323', '131123',
  '131321', '112313', '132113', '132311', '211313', '231113', '231311',
  '112133', '112331', '132131', '113123', '113321', '133121', '313121',
  '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114',
  '413111', '241112', '134111', '111242', '121142', '121241', '114212',
  '124112', '124211', '411212', '421112', '421211', '212141', '214121',
  '412121', '111143', '111341', '131141', '114113', '114311', '411113',
  '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232',
];
const START_B = 104;
const STOP_PATTERN = '2331112';

// text → alternating bar/space widths in modules (bar first)
const encode = (text) => {
  const value = String(text ?? '');
  if (!value.length) throw new Error('code128png: empty payload');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c > 126) throw new Error(`code128png: unsupported character at ${i}`);
  }
  const codes = [START_B];
  let checksum = START_B;
  for (let i = 0; i < value.length; i++) {
    const v = value.charCodeAt(i) - 32;
    codes.push(v);
    checksum += v * (i + 1);
  }
  codes.push(checksum % 103);
  let pattern = '';
  for (const code of codes) pattern += PATTERNS[code];
  pattern += STOP_PATTERN;
  return pattern.split('').map(Number);
};

// ---- minimal PNG writer (grayscale, 8-bit, no interlace) ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

/**
 * Render a Code128 barcode as a PNG buffer.
 *
 * @param {string} text - payload (e.g. "CDC042")
 * @param {Object} [opts]
 * @param {number} [opts.scale=3]    px per module (3 prints/scans reliably)
 * @param {number} [opts.height=90]  bar height in px
 * @param {number} [opts.quiet=10]   quiet zone in modules each side (spec min)
 * @returns {Buffer} PNG file contents
 */
const code128Png = (text, opts = {}) => {
  const { scale = 3, height = 90, quiet = 10 } = opts;
  const widths = encode(text);

  const totalModules = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  const width = totalModules * scale;

  // One scanline: 0x00 = black bar, 0xff = white. All rows identical.
  const line = Buffer.alloc(width, 0xff);
  let x = quiet * scale;
  let isBar = true;
  for (const w of widths) {
    const px = w * scale;
    if (isBar) line.fill(0x00, x, x + px);
    x += px;
    isBar = !isBar;
  }

  // Raw image data: each row prefixed with filter byte 0.
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    line.copy(raw, y * (width + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // colour type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

module.exports = { code128Png };
