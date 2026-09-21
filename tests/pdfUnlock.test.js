const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pdfUnlock = require('../utils/pdfUnlock');

// Fixtures generated with qpdf (see the build session): plain.pdf is a valid
// unencrypted PDF; locked.pdf is the same encrypted with user password "secret".
const FIX = path.join(__dirname, 'fixtures');
const locked = fs.readFileSync(path.join(FIX, 'locked.pdf'));
const plain = fs.readFileSync(path.join(FIX, 'plain.pdf'));

describe('pdfUnlock password candidates', () => {
  test('derives ID + DOB shapes, empty password first', () => {
    const c = pdfUnlock.passwordCandidates({ idNumber: '12345678', dateOfBirth: '1979-03-14' });
    assert.equal(c[0], '');                       // owner-only / no user password
    assert.ok(c.includes('12345678'));            // national ID
    assert.ok(c.includes('14031979'));            // DDMMYYYY
    assert.ok(c.includes('19790314'));            // YYYYMMDD
    assert.ok(c.includes('140379'));              // DDMMYY
  });

  test('no patient → only the empty password', () => {
    assert.deepEqual(pdfUnlock.passwordCandidates(null), ['']);
  });
});

describe('pdfUnlock encryption detection and decryption', () => {
  test('isEncrypted is true for a locked PDF, false for a plain one', async () => {
    assert.equal(await pdfUnlock.isEncrypted(locked), true);
    assert.equal(await pdfUnlock.isEncrypted(plain), false);
  });

  test('decrypt with the correct password returns a valid, unlocked PDF', async () => {
    const out = await pdfUnlock.decrypt(locked, 'secret');
    assert.equal(out.slice(0, 5).toString('latin1'), '%PDF-');
    assert.equal(await pdfUnlock.isEncrypted(out), false);
  });

  test('decrypt with a wrong password throws INVALID_PASSWORD', async () => {
    await assert.rejects(
      () => pdfUnlock.decrypt(locked, 'wrong'),
      (e) => e.code === 'INVALID_PASSWORD',
    );
  });

  test('tryPatientPasswords unlocks when a candidate matches, else null', async () => {
    const hit = await pdfUnlock.tryPatientPasswords(locked, { idNumber: 'secret' });
    assert.ok(hit && hit.password === 'secret');
    assert.equal(hit.buffer.slice(0, 5).toString('latin1'), '%PDF-');

    const miss = await pdfUnlock.tryPatientPasswords(locked, { idNumber: 'nope', dateOfBirth: '1980-01-01' });
    assert.equal(miss, null);
  });
});
