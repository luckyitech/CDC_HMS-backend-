const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { aesCmac, computeSunMac, verifySun, parseTapUrl, generateTagKey } = require('../utils/ntag424');

// =====================================================================
// The tap verifier must agree with the chip before any controller trusts it.
//
// RFC 4493 pins the CMAC primitive; the two NXP vectors pin the session-key
// derivation, the LSB-first counter, the empty MAC input and the odd-byte
// truncation. If any of these fail, no tag will ever verify — and if the
// verifier is wrong in the other direction, a forged URL would check
// someone in.
// =====================================================================

const ZERO_KEY = '00000000000000000000000000000000';

describe('AES-CMAC (RFC 4493 vectors, AES-128)', () => {
  const K = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  const M = Buffer.from(
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51'
    + '30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710', 'hex');

  test('empty message', () => {
    assert.equal(aesCmac(K, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
  });
  test('16-byte message (complete block)', () => {
    assert.equal(aesCmac(K, M.subarray(0, 16)).toString('hex'), '070a16b46b4d4144f79bdd9dd04a287c');
  });
  test('40-byte message (padded last block)', () => {
    assert.equal(aesCmac(K, M.subarray(0, 40)).toString('hex'), 'dfa66747de9ae63030ca32611497c827');
  });
  test('64-byte message', () => {
    assert.equal(aesCmac(K, M).toString('hex'), '51f0bebf7e3b9d92fc49741779363cfe');
  });
});

describe('NTAG 424 DNA SUN message (NXP vectors, plain UID + counter mirror, empty MAC input)', () => {
  test('plain mirror, key 00…00, UID 041E3C8A2D6B80, ctr 000006', () => {
    assert.equal(computeSunMac({ keyHex: ZERO_KEY, uidHex: '041E3C8A2D6B80', counter: 6 }), '4B00064004B0B3D3');
  });

  test('AN12196 §4.4 example (UID 04DE5F1EACC040, ctr 0x3D)', () => {
    // The application note carries UID and counter encrypted; the decrypted
    // PICCData is C7 04DE5F1EACC040 3D0000 …, i.e. counter 61.
    assert.equal(computeSunMac({ keyHex: ZERO_KEY, uidHex: '04DE5F1EACC040', counter: 0x3D }), '94EED9EE65337086');
  });

  test('verifySun accepts a genuine tap and reports its counter', () => {
    const r = verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '000006', cmacHex: '4B00064004B0B3D3', keyHex: ZERO_KEY });
    assert.deepEqual(r, { ok: true, counter: 6, reason: null });
  });

  test('lowercase input is accepted', () => {
    const r = verifySun({ uidHex: '041e3c8a2d6b80', ctrHex: '000006', cmacHex: '4b00064004b0b3d3', keyHex: ZERO_KEY.toLowerCase() });
    assert.equal(r.ok, true);
  });

  test('wrong key → bad_signature', () => {
    const r = verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '000006', cmacHex: '4B00064004B0B3D3', keyHex: '0123456789ABCDEF0123456789ABCDEF' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_signature');
  });

  test('tampered counter → bad_signature (the counter is inside the session key)', () => {
    const r = verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '000007', cmacHex: '4B00064004B0B3D3', keyHex: ZERO_KEY });
    assert.equal(r.ok, false);
  });

  test('tampered UID → bad_signature', () => {
    const r = verifySun({ uidHex: '041E3C8A2D6B81', ctrHex: '000006', cmacHex: '4B00064004B0B3D3', keyHex: ZERO_KEY });
    assert.equal(r.ok, false);
  });

  test('malformed parameters are refused without throwing', () => {
    assert.equal(verifySun({ uidHex: '04', ctrHex: '000006', cmacHex: '4B00064004B0B3D3', keyHex: ZERO_KEY }).reason, 'bad_uid');
    assert.equal(verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '6', cmacHex: '4B00064004B0B3D3', keyHex: ZERO_KEY }).reason, 'bad_counter');
    assert.equal(verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '000006', cmacHex: 'zz', keyHex: ZERO_KEY }).reason, 'bad_cmac');
    assert.equal(verifySun({ uidHex: '041E3C8A2D6B80', ctrHex: '000006', cmacHex: '4B00064004B0B3D3', keyHex: 'short' }).reason, 'bad_key');
    assert.equal(verifySun({}).ok, false);
  });

  test('a fresh key from generateTagKey verifies its own taps at every counter', () => {
    const keyHex = generateTagKey();
    assert.match(keyHex, /^[0-9A-F]{32}$/);
    for (const counter of [1, 255, 256, 65535, 0xFFFFFF]) {
      const ctrHex = counter.toString(16).toUpperCase().padStart(6, '0');
      const cmacHex = computeSunMac({ keyHex, uidHex: '04A1B2C3D4E5F6', counter });
      assert.equal(verifySun({ uidHex: '04A1B2C3D4E5F6', ctrHex, cmacHex, keyHex }).ok, true, `counter ${counter}`);
    }
  });
});

describe('parseTapUrl', () => {
  test('pulls uid/ctr/cmac out of what the phone opened, uppercased', () => {
    const p = parseTapUrl('https://cdiabetescentre.com/hr/tap?uid=041e3c8a2d6b80&ctr=000006&cmac=4b00064004b0b3d3');
    assert.deepEqual(p, { uid: '041E3C8A2D6B80', ctr: '000006', cmac: '4B00064004B0B3D3' });
  });
  test('missing parameter or garbage → null', () => {
    assert.equal(parseTapUrl('https://cdiabetescentre.com/hr/tap?uid=04'), null);
    assert.equal(parseTapUrl('not a url'), null);
    assert.equal(parseTapUrl(undefined), null);
  });
});
