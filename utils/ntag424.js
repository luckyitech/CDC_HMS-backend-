// =====================================================================
// NTAG 424 DNA — Secure Unique NFC (SUN) message verification.
//
// Each entrance tag is an NXP NTAG 424 DNA programmed with Secure Dynamic
// Messaging: every read mirrors the tag's 7-byte UID, a 3-byte read counter
// and an 8-byte CMAC into the URL it opens
// (…/hr/tap?uid=<14 hex>&ctr=<6 hex>&cmac=<16 hex>). The CMAC is computed by
// the chip with a session key derived from a per-tag secret (K1) and the
// UID + counter, so a URL proves (a) this physical tag was read and (b) it
// was read AFTER the previous one — a saved or screenshotted URL replays a
// counter the server has already seen and is refused.
//
// References: NXP AN12196 "NTAG 424 DNA and NTAG 424 DNA TagTamper features
// and hints" §4.4–4.5 (SUN message, session key derivation) and NT4H2421Gx
// datasheet §9.3.9 (SDM MAC). AES-CMAC per RFC 4493. Node `crypto` only —
// no dependency.
//
// How the tags are programmed (build spec §9): SDM enabled, PICCData in
// PLAIN mirror (UID + SDMReadCtr), SDMMACInputOffset == SDMMACOffset so the
// MAC is over an EMPTY input, file-read key K1 = the per-tag key held in
// HrNfcTags.keyEncrypted.
//
// Test vectors (tests/ntag424.test.js):
//   plain mirror, key 00…00, UID 041E3C8A2D6B80, ctr 000006 → 4B00064004B0B3D3
//   AN12196 §4.4 example, key 00…00, UID 04DE5F1EACC040, ctr 00003D → 94EED9EE65337086
//   (the AN12196 example carries its UID/counter encrypted; decrypted PICCData
//    = C7 04DE5F1EACC040 3D0000 …, i.e. counter 0x3D = 61. Same session-key
//    derivation, same empty MAC input.)
// =====================================================================

const crypto = require('crypto');

const BLOCK = 16;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

const aesEcbBlock = (key, block) => {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
};

const shiftLeftOne = (buf) => {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    out[i] = ((buf[i] << 1) & 0xff) | carry;
    carry = (buf[i] & 0x80) ? 1 : 0;
  }
  return { out, carry };
};

const deriveSubkey = (from) => {
  const { out, carry } = shiftLeftOne(from);
  if (carry) out[BLOCK - 1] ^= 0x87;   // Rb for AES-128
  return out;
};

const xorBlocks = (a, b) => {
  const o = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i++) o[i] = a[i] ^ b[i];
  return o;
};

/**
 * AES-CMAC (RFC 4493) with a 16-byte key. Returns the full 16-byte MAC.
 */
const aesCmac = (keyBuf, msgBuf) => {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== BLOCK) throw new Error('aesCmac: key must be 16 bytes');
  const msg = Buffer.isBuffer(msgBuf) ? msgBuf : Buffer.from(msgBuf || '');
  const L  = aesEcbBlock(keyBuf, ZERO_BLOCK);
  const K1 = deriveSubkey(L);
  const K2 = deriveSubkey(K1);

  const n = msg.length === 0 ? 1 : Math.ceil(msg.length / BLOCK);
  const lastIsComplete = msg.length > 0 && msg.length % BLOCK === 0;
  let lastBlock;
  if (lastIsComplete) {
    lastBlock = xorBlocks(msg.subarray((n - 1) * BLOCK), K1);
  } else {
    const padded = Buffer.alloc(BLOCK);
    const tail = msg.subarray((n - 1) * BLOCK);
    tail.copy(padded);
    padded[tail.length] = 0x80;
    lastBlock = xorBlocks(padded, K2);
  }

  let x = ZERO_BLOCK;
  for (let i = 0; i < n - 1; i++) {
    x = aesEcbBlock(keyBuf, xorBlocks(x, msg.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return aesEcbBlock(keyBuf, xorBlocks(x, lastBlock));
};

const HEX = /^[0-9a-fA-F]+$/;
const isHex = (s, len) => typeof s === 'string' && s.length === len && HEX.test(s);

/** The 3-byte SDM read counter as the chip mirrors it (big-endian hex) → integer. */
const parseCounter = (ctrHex) => parseInt(ctrHex, 16);

/**
 * The session key the chip used for this read:
 *   SV2 = 3C C3 00 01 00 80 ‖ UID (7 bytes) ‖ SDMReadCtr (3 bytes, LSB first)
 *   SesSDMFileReadMACKey = AES-CMAC(K1, SV2)
 */
const sessionMacKey = (keyBuf, uidBuf, counter) => {
  const ctrLE = Buffer.from([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff]);
  const sv2 = Buffer.concat([Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]), uidBuf, ctrLE]);
  return aesCmac(keyBuf, sv2);
};

/** The chip's truncation: the 8 odd-indexed bytes of the full CMAC. */
const truncateMac = (full) => {
  const t = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) t[i] = full[2 * i + 1];
  return t;
};

/**
 * Compute the SDMMAC a genuine tag would mirror for this key, UID and
 * counter (uppercase 16-hex). Used by the verifier, by "test a tap URL" and
 * by the scratch-DB harness's scripted fake tag.
 *
 * @param {object} p
 * @param {string} p.keyHex   K1, 32 hex
 * @param {string} p.uidHex   14 hex
 * @param {number} p.counter  integer read counter
 * @param {Buffer|string} [p.macInput]  the SDMMACInput bytes; EMPTY for our tags
 */
const computeSunMac = ({ keyHex, uidHex, counter, macInput = Buffer.alloc(0) }) => {
  const ses = sessionMacKey(Buffer.from(keyHex, 'hex'), Buffer.from(uidHex, 'hex'), counter);
  return truncateMac(aesCmac(ses, macInput)).toString('hex').toUpperCase();
};

/**
 * Verify a tap URL's parameters against the tag's stored key.
 *
 * Constant-time comparison; lowercase input accepted. Never throws on bad
 * input — returns { ok:false, reason }. Replay (counter not advancing) is the
 * CALLER's check, because it needs the stored lastCounter.
 *
 * @returns {{ ok:boolean, counter:number|null, reason:string|null }}
 */
const verifySun = ({ uidHex, ctrHex, cmacHex, keyHex, macInput }) => {
  if (!isHex(uidHex, 14))  return { ok: false, counter: null, reason: 'bad_uid' };
  if (!isHex(ctrHex, 6))   return { ok: false, counter: null, reason: 'bad_counter' };
  if (!isHex(cmacHex, 16)) return { ok: false, counter: null, reason: 'bad_cmac' };
  if (!isHex(keyHex, 32))  return { ok: false, counter: null, reason: 'bad_key' };
  const counter = parseCounter(ctrHex);
  const expected = computeSunMac({ keyHex, uidHex, counter, macInput });
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(cmacHex.toUpperCase(), 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, counter, reason: ok ? null : 'bad_signature' };
};

/**
 * Pull uid/ctr/cmac out of a full tap URL (what a phone opened), for the
 * settings screen's "test a tap URL". Returns null when any is missing.
 */
const parseTapUrl = (url) => {
  try {
    const u = new URL(String(url));
    const uid = u.searchParams.get('uid');
    const ctr = u.searchParams.get('ctr');
    const cmac = u.searchParams.get('cmac');
    if (!uid || !ctr || !cmac) return null;
    return { uid: uid.toUpperCase(), ctr: ctr.toUpperCase(), cmac: cmac.toUpperCase() };
  } catch {
    return null;
  }
};

/** 32 random hex characters — a fresh K1 for a new tag (shown once). */
const generateTagKey = () => crypto.randomBytes(16).toString('hex').toUpperCase();

module.exports = {
  aesCmac,
  computeSunMac,
  verifySun,
  parseCounter,
  parseTapUrl,
  generateTagKey,
};
